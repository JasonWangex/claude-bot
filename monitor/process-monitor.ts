/**
 * Claude 进程监控器
 * 监控 Claude CLI 会话进程，检测意外退出并发送 Telegram 通知
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProcessInfo, MonitorConfig, CrashNotification, ServiceInfo, ServiceNotification } from './types.js';

const execAsync = promisify(exec);

export class ProcessMonitor {
  private bot: Telegraf;
  private config: MonitorConfig;
  private trackedProcesses: Map<number, ProcessInfo> = new Map();
  private notificationHistory: Map<string, number> = new Map(); // sessionId -> lastNotificationTime
  private trackedServices: Map<string, ServiceInfo> = new Map(); // serviceName -> ServiceInfo
  private checkTimer?: NodeJS.Timeout;
  private serviceCheckTimer?: NodeJS.Timeout;

  constructor(config: MonitorConfig) {
    this.config = config;

    // 配置代理
    const botOptions: any = {};
    if (config.proxyUrl) {
      let agent;
      if (config.proxyUrl.startsWith('socks')) {
        agent = new SocksProxyAgent(config.proxyUrl);
      } else {
        agent = new HttpsProxyAgent(config.proxyUrl);
      }
      botOptions.telegram = { agent };
    }

    this.bot = new Telegraf(config.telegramToken, botOptions);
  }

  /**
   * 启动监控
   */
  async start(monitoredServices: string[] = ['claude-telegram']): Promise<void> {
    console.log(`[ProcessMonitor] Starting with check interval: ${this.config.checkInterval}ms`);
    console.log(`[ProcessMonitor] Cooldown period: ${this.config.cooldownPeriod}ms`);

    // 初始化服务监控
    this.initServiceMonitoring(monitoredServices);

    // 初始扫描
    await this.scanProcesses();
    await this.checkServices();

    // 定期检查进程
    this.checkTimer = setInterval(async () => {
      await this.checkProcesses();
    }, this.config.checkInterval);

    // 定期检查服务（间隔稍长，默认 30 秒）
    const serviceCheckInterval = 30000; // 30 秒
    this.serviceCheckTimer = setInterval(async () => {
      await this.checkServices();
    }, serviceCheckInterval);

    console.log(`[ServiceMonitor] Service check interval: ${serviceCheckInterval}ms`);

    // 优雅退出
    process.once('SIGINT', () => this.stop('SIGINT'));
    process.once('SIGTERM', () => this.stop('SIGTERM'));
  }

  /**
   * 停止监控
   */
  private stop(signal: string): void {
    console.log(`[ProcessMonitor] Received ${signal}, stopping...`);
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    if (this.serviceCheckTimer) {
      clearInterval(this.serviceCheckTimer);
      this.serviceCheckTimer = undefined;
    }
    process.exit(0);
  }

  /**
   * 扫描当前所有 Claude CLI 进程
   */
  private async scanProcesses(): Promise<void> {
    try {
      // 查找所有 claude 进程
      const { stdout } = await execAsync('ps aux | grep -E "claude.*--session-id" | grep -v grep');
      const lines = stdout.trim().split('\n').filter(line => line.length > 0);

      for (const line of lines) {
        const parsed = this.parseProcessLine(line);
        if (parsed) {
          this.trackedProcesses.set(parsed.pid, parsed);
          console.log(`[ProcessMonitor] Tracking process: PID=${parsed.pid}, Session=${parsed.sessionId}, Topic=${parsed.topicId || 'N/A'}`);
        }
      }
    } catch (error: any) {
      // grep 没有匹配时会返回错误码 1，这是正常的
      if (!error.message.includes('Command failed')) {
        console.error('[ProcessMonitor] Error scanning processes:', error.message);
      }
    }
  }

  /**
   * 检查已追踪的进程是否还存活
   */
  private async checkProcesses(): Promise<void> {
    // 获取当前所有活跃的 claude 进程
    const activePids = await this.getActiveClaudePids();

    // 检查已追踪的进程
    for (const [pid, info] of this.trackedProcesses.entries()) {
      if (!activePids.has(pid)) {
        // 进程已退出 - 尝试获取退出信息
        const exitInfo = await this.getProcessExitInfo(pid);
        await this.handleProcessExit(info, exitInfo);
        this.trackedProcesses.delete(pid);
      }
    }

    // 追踪新进程
    for (const pid of activePids.keys()) {
      if (!this.trackedProcesses.has(pid)) {
        const processInfo = await this.getProcessInfo(pid);
        if (processInfo) {
          this.trackedProcesses.set(pid, processInfo);
          console.log(`[ProcessMonitor] New process detected: PID=${pid}, Session=${processInfo.sessionId}, Topic=${processInfo.topicId || 'N/A'}`);
        }
      }
    }
  }

  /**
   * 获取所有活跃的 Claude CLI 进程 PID
   */
  private async getActiveClaudePids(): Promise<Set<number>> {
    const pids = new Set<number>();
    try {
      const { stdout } = await execAsync('ps aux | grep -E "claude.*--session-id" | grep -v grep | awk \'{print $2}\'');
      const lines = stdout.trim().split('\n').filter(line => line.length > 0);
      for (const line of lines) {
        const pid = parseInt(line, 10);
        if (!isNaN(pid)) {
          pids.add(pid);
        }
      }
    } catch (error: any) {
      // grep 没有匹配是正常的
      if (!error.message.includes('Command failed')) {
        console.error('[ProcessMonitor] Error getting active PIDs:', error.message);
      }
    }
    return pids;
  }

  /**
   * 获取进程详细信息
   */
  private async getProcessInfo(pid: number): Promise<ProcessInfo | null> {
    try {
      const { stdout } = await execAsync(`ps -p ${pid} -o args=`);
      const cmdline = stdout.trim();
      const parsed = this.parseCommandLine(cmdline, pid);
      return parsed;
    } catch (error) {
      return null;
    }
  }

  /**
   * 解析 ps 输出行
   */
  private parseProcessLine(line: string): ProcessInfo | null {
    // ps aux 格式: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) return null;

    const pid = parseInt(parts[1], 10);
    if (isNaN(pid)) return null;

    const cmdline = parts.slice(10).join(' ');
    return this.parseCommandLine(cmdline, pid);
  }

  /**
   * 解析命令行参数提取 session-id 和 topic-id
   */
  private parseCommandLine(cmdline: string, pid: number): ProcessInfo | null {
    // 查找 --session-id <id>
    const sessionMatch = cmdline.match(/--session-id\s+([a-f0-9\-]+)/);
    if (!sessionMatch) return null;

    const sessionId = sessionMatch[1];

    // 查找 --lock-key，格式为 groupId:topicId:timestamp
    const lockKeyMatch = cmdline.match(/--lock-key\s+"?([^"\s]+)"?/);
    let topicId: number | undefined;

    if (lockKeyMatch) {
      const lockKey = lockKeyMatch[1];
      const parts = lockKey.split(':');
      if (parts.length >= 2) {
        const topic = parseInt(parts[1], 10);
        if (!isNaN(topic)) {
          topicId = topic;
        }
      }
    }

    return {
      pid,
      sessionId,
      topicId,
      startTime: Date.now()
    };
  }

  /**
   * 获取进程退出信息（通过 dmesg 或其他方式）
   */
  private async getProcessExitInfo(pid: number): Promise<{ exitCode?: number; signal?: string } | null> {
    try {
      // 尝试从 dmesg 中查找 OOM Killer 相关信息
      const { stdout } = await execAsync(`dmesg | grep -i "killed process ${pid}" | tail -1`);
      if (stdout.trim()) {
        return { signal: 'SIGKILL (OOM)' };
      }
    } catch (error) {
      // dmesg 可能需要 sudo 权限，忽略错误
    }
    return null;
  }

  /**
   * 处理进程退出
   */
  private async handleProcessExit(
    info: ProcessInfo,
    exitInfo: { exitCode?: number; signal?: string } | null
  ): Promise<void> {
    const runtime = Math.round((Date.now() - info.startTime) / 1000);

    console.log(
      `[ProcessMonitor] Process exited: PID=${info.pid}, Session=${info.sessionId}, ` +
      `Topic=${info.topicId || 'N/A'}, Runtime=${runtime}s, ` +
      `ExitCode=${exitInfo?.exitCode ?? 'N/A'}, Signal=${exitInfo?.signal ?? 'N/A'}`
    );

    // 判断是否为异常退出
    const isAbnormal = this.isAbnormalExit(runtime, exitInfo);

    if (!isAbnormal) {
      console.log(`[ProcessMonitor] Normal exit detected, skipping notification`);
      return;
    }

    // 检查冷却期
    const lastNotification = this.notificationHistory.get(info.sessionId);
    const now = Date.now();

    if (lastNotification && (now - lastNotification) < this.config.cooldownPeriod) {
      const remaining = Math.round((this.config.cooldownPeriod - (now - lastNotification)) / 1000);
      console.log(`[ProcessMonitor] Skipping notification (cooldown): ${remaining}s remaining`);
      return;
    }

    // 发送通知
    await this.sendCrashNotification({
      sessionId: info.sessionId,
      topicId: info.topicId,
      pid: info.pid,
      exitCode: exitInfo?.exitCode ?? null,
      signal: exitInfo?.signal ?? null,
      timestamp: now,
      lastSeen: info.startTime
    });

    // 记录通知时间
    this.notificationHistory.set(info.sessionId, now);
  }

  /**
   * 判断是否为异常退出
   *
   * 异常退出的判断标准：
   * 1. 运行时间过短（< 配置的最小阈值）且没有正常完成
   * 2. 检测到 OOM 或其他系统信号
   * 3. 运行时间异常长（> 配置的最大阈值）可能是超时被杀
   */
  private isAbnormalExit(
    runtimeSeconds: number,
    exitInfo: { exitCode?: number; signal?: string } | null
  ): boolean {
    // 存在异常信号（OOM Killer 等）
    if (exitInfo?.signal) {
      return true;
    }

    // 退出码非 0（如果能获取到）
    if (exitInfo?.exitCode !== undefined && exitInfo.exitCode !== 0) {
      return true;
    }

    // 运行时间过短 - 可能是启动失败或立即崩溃
    if (runtimeSeconds < this.config.minRuntimeThreshold) {
      return true;
    }

    // 运行时间异常长 - 可能是超时被杀
    // 注意：正常的长时间任务不会触发，因为它们应该在完成后正常退出
    if (runtimeSeconds > this.config.maxRuntimeThreshold) {
      console.log(`[ProcessMonitor] Long-running process detected: ${runtimeSeconds}s`);
      return true;
    }

    // 其他情况认为是正常退出（任务完成）
    return false;
  }

  /**
   * 发送崩溃通知到 Telegram
   */
  private async sendCrashNotification(notification: CrashNotification): Promise<void> {
    try {
      const runtime = Math.round((notification.timestamp - notification.lastSeen) / 1000);
      const message = this.formatCrashMessage(notification, runtime);

      if (notification.topicId) {
        // 发送到指定 topic
        await this.bot.telegram.sendMessage(
          this.config.authorizedChatId,
          message,
          {
            parse_mode: 'HTML',
            message_thread_id: notification.topicId
          }
        );
      } else {
        // 发送到 General topic
        await this.bot.telegram.sendMessage(
          this.config.authorizedChatId,
          message,
          { parse_mode: 'HTML' }
        );
      }

      console.log(`[ProcessMonitor] Notification sent for session: ${notification.sessionId}`);
    } catch (error: any) {
      console.error('[ProcessMonitor] Failed to send notification:', error.message);
    }
  }

  /**
   * 格式化崩溃消息
   */
  private formatCrashMessage(notification: CrashNotification, runtime: number): string {
    const time = new Date(notification.timestamp).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false
    });

    let message = `⚠️ <b>Claude 进程意外退出</b>\n\n`;
    message += `📅 时间: ${time}\n`;
    message += `🔑 Session: <code>${notification.sessionId}</code>\n`;
    message += `🆔 PID: <code>${notification.pid}</code>\n`;

    if (notification.topicId) {
      message += `📂 Topic: <code>${notification.topicId}</code>\n`;
    }

    message += `⏱ 运行时长: ${this.formatDuration(runtime)}\n`;

    if (notification.exitCode !== null) {
      message += `📤 退出码: <code>${notification.exitCode}</code>\n`;
    }

    if (notification.signal) {
      message += `⚡ 信号: <code>${notification.signal}</code>\n`;
    }

    return message;
  }

  /**
   * 格式化持续时间
   */
  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}秒`;
    } else if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}分${secs}秒`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}小时${mins}分`;
    }
  }

  // ==================== 服务监控功能 ====================

  /**
   * 初始化服务监控
   */
  private initServiceMonitoring(services: string[]): void {
    for (const service of services) {
      this.trackedServices.set(service, {
        name: service,
        isActive: true, // 假设初始状态为运行中
        lastChecked: Date.now(),
        failureCount: 0
      });
    }

    console.log(`[ServiceMonitor] Initialized monitoring for: ${services.join(', ')}`);
  }

  /**
   * 检查 systemd 服务状态
   */
  private async checkServiceStatus(serviceName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`systemctl --user is-active ${serviceName}`);
      const status = stdout.trim();
      return status === 'active';
    } catch (error) {
      // systemctl is-active 返回非0退出码表示服务不活跃
      return false;
    }
  }

  /**
   * 检查所有追踪的服务
   */
  private async checkServices(): Promise<void> {
    for (const [serviceName, serviceInfo] of this.trackedServices.entries()) {
      const isActive = await this.checkServiceStatus(serviceName);
      const now = Date.now();

      serviceInfo.lastChecked = now;

      if (!isActive && serviceInfo.isActive) {
        // 服务从运行状态变为失败状态
        serviceInfo.isActive = false;
        serviceInfo.failureCount++;
        serviceInfo.lastFailureTime = now;

        console.log(`[ServiceMonitor] Service ${serviceName} failed! Failure count: ${serviceInfo.failureCount}`);

        // 发送失败通知
        await this.sendServiceNotification({
          serviceName,
          status: 'failed',
          timestamp: now,
          failureCount: serviceInfo.failureCount
        });

      } else if (isActive && !serviceInfo.isActive) {
        // 服务从失败状态恢复到运行状态
        serviceInfo.isActive = true;

        console.log(`[ServiceMonitor] Service ${serviceName} recovered!`);

        // 发送恢复通知
        await this.sendServiceNotification({
          serviceName,
          status: 'recovered',
          timestamp: now,
          failureCount: serviceInfo.failureCount
        });

        // 恢复后重置失败计数
        serviceInfo.failureCount = 0;
        serviceInfo.lastFailureTime = undefined;
      }
    }
  }

  /**
   * 发送服务状态通知到 Telegram
   */
  private async sendServiceNotification(notification: ServiceNotification): Promise<void> {
    try {
      const message = this.formatServiceMessage(notification);

      await this.bot.telegram.sendMessage(
        this.config.authorizedChatId,
        message,
        { parse_mode: 'HTML' }
      );

      console.log(`[ServiceMonitor] Notification sent for service: ${notification.serviceName} (${notification.status})`);
    } catch (error: any) {
      console.error('[ServiceMonitor] Failed to send notification:', error.message);
    }
  }

  /**
   * 格式化服务状态消息
   */
  private formatServiceMessage(notification: ServiceNotification): string {
    const time = new Date(notification.timestamp).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false
    });

    if (notification.status === 'failed') {
      let message = `🔴 <b>服务异常</b>\n\n`;
      message += `📅 时间: ${time}\n`;
      message += `🔧 服务: <code>${notification.serviceName}</code>\n`;
      message += `❌ 状态: 已停止\n`;
      message += `🔢 失败次数: ${notification.failureCount}\n`;

      if (notification.message) {
        message += `📝 详情: ${notification.message}\n`;
      }

      message += `\n💡 建议: 检查服务日志 <code>journalctl --user -u ${notification.serviceName} -n 50</code>`;

      return message;
    } else {
      let message = `✅ <b>服务已恢复</b>\n\n`;
      message += `📅 时间: ${time}\n`;
      message += `🔧 服务: <code>${notification.serviceName}</code>\n`;
      message += `✓ 状态: 运行中\n`;

      if (notification.failureCount > 0) {
        message += `📊 之前失败次数: ${notification.failureCount}\n`;
      }

      return message;
    }
  }
}
