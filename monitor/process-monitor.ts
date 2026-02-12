/**
 * Claude 进程监控器（Discord 版）
 * 监控 Claude CLI 会话进程，检测意外退出并发送 Discord 通知
 * 使用 Discord REST API 直接发送消息（不需要 discord.js）
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { ProcessInfo, MonitorConfig, CrashNotification, ServiceInfo, ServiceNotification } from './types.js';

const execAsync = promisify(exec);

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export class ProcessMonitor {
  private config: MonitorConfig;
  private trackedProcesses: Map<number, ProcessInfo> = new Map();
  private notificationHistory: Map<string, number> = new Map();
  private trackedServices: Map<string, ServiceInfo> = new Map();
  private checkTimer?: NodeJS.Timeout;
  private serviceCheckTimer?: NodeJS.Timeout;

  constructor(config: MonitorConfig) {
    this.config = config;
  }

  async start(monitoredServices: string[] = ['claude-discord']): Promise<void> {
    console.log(`[ProcessMonitor] Starting with check interval: ${this.config.checkInterval}ms`);
    console.log(`[ProcessMonitor] Cooldown period: ${this.config.cooldownPeriod}ms`);

    this.initServiceMonitoring(monitoredServices);
    await this.scanProcesses();
    await this.checkServices();

    this.checkTimer = setInterval(async () => {
      await this.checkProcesses();
    }, this.config.checkInterval);

    const serviceCheckInterval = 30000;
    this.serviceCheckTimer = setInterval(async () => {
      await this.checkServices();
    }, serviceCheckInterval);

    console.log(`[ServiceMonitor] Service check interval: ${serviceCheckInterval}ms`);

    process.once('SIGINT', () => this.stop('SIGINT'));
    process.once('SIGTERM', () => this.stop('SIGTERM'));
  }

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

  private async scanProcesses(): Promise<void> {
    try {
      const { stdout } = await execAsync('ps aux | grep -E "claude.*--session-id" | grep -v grep');
      const lines = stdout.trim().split('\n').filter(line => line.length > 0);
      for (const line of lines) {
        const parsed = this.parseProcessLine(line);
        if (parsed) {
          this.trackedProcesses.set(parsed.pid, parsed);
          console.log(`[ProcessMonitor] Tracking process: PID=${parsed.pid}, Session=${parsed.sessionId}, Thread=${parsed.threadId || 'N/A'}`);
        }
      }
    } catch (error: any) {
      if (!error.message.includes('Command failed')) {
        console.error('[ProcessMonitor] Error scanning processes:', error.message);
      }
    }
  }

  private async checkProcesses(): Promise<void> {
    const activePids = await this.getActiveClaudePids();

    for (const [pid, info] of this.trackedProcesses.entries()) {
      if (!activePids.has(pid)) {
        const exitInfo = await this.getProcessExitInfo(pid);
        await this.handleProcessExit(info, exitInfo);
        this.trackedProcesses.delete(pid);
      }
    }

    for (const pid of activePids.keys()) {
      if (!this.trackedProcesses.has(pid)) {
        const processInfo = await this.getProcessInfo(pid);
        if (processInfo) {
          this.trackedProcesses.set(pid, processInfo);
          console.log(`[ProcessMonitor] New process detected: PID=${pid}, Session=${processInfo.sessionId}, Thread=${processInfo.threadId || 'N/A'}`);
        }
      }
    }
  }

  private async getActiveClaudePids(): Promise<Set<number>> {
    const pids = new Set<number>();
    try {
      const { stdout } = await execAsync('ps aux | grep -E "claude.*--session-id" | grep -v grep | awk \'{print $2}\'');
      const lines = stdout.trim().split('\n').filter(line => line.length > 0);
      for (const line of lines) {
        const pid = parseInt(line, 10);
        if (!isNaN(pid)) pids.add(pid);
      }
    } catch (error: any) {
      if (!error.message.includes('Command failed')) {
        console.error('[ProcessMonitor] Error getting active PIDs:', error.message);
      }
    }
    return pids;
  }

  private async getProcessInfo(pid: number): Promise<ProcessInfo | null> {
    try {
      const { stdout } = await execAsync(`ps -p ${pid} -o args=`);
      return this.parseCommandLine(stdout.trim(), pid);
    } catch {
      return null;
    }
  }

  private parseProcessLine(line: string): ProcessInfo | null {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) return null;
    const pid = parseInt(parts[1], 10);
    if (isNaN(pid)) return null;
    return this.parseCommandLine(parts.slice(10).join(' '), pid);
  }

  private parseCommandLine(cmdline: string, pid: number): ProcessInfo | null {
    const sessionMatch = cmdline.match(/--session-id\s+([a-f0-9\-]+)/);
    if (!sessionMatch) return null;
    const sessionId = sessionMatch[1];

    // lock-key 格式: guildId:threadId:timestamp (all strings)
    const lockKeyMatch = cmdline.match(/--lock-key\s+"?([^"\s]+)"?/);
    let threadId: string | undefined;
    if (lockKeyMatch) {
      const parts = lockKeyMatch[1].split(':');
      if (parts.length >= 2) {
        threadId = parts[1];
      }
    }

    return { pid, sessionId, threadId, startTime: Date.now() };
  }

  private async getProcessExitInfo(pid: number): Promise<{ exitCode?: number; signal?: string } | null> {
    try {
      const { stdout } = await execAsync(`dmesg | grep -i "killed process ${pid}" | tail -1`);
      if (stdout.trim()) return { signal: 'SIGKILL (OOM)' };
    } catch { /* ignore */ }
    return null;
  }

  private async handleProcessExit(
    info: ProcessInfo,
    exitInfo: { exitCode?: number; signal?: string } | null,
  ): Promise<void> {
    const runtime = Math.round((Date.now() - info.startTime) / 1000);
    console.log(
      `[ProcessMonitor] Process exited: PID=${info.pid}, Session=${info.sessionId}, ` +
      `Thread=${info.threadId || 'N/A'}, Runtime=${runtime}s`
    );

    if (!this.isAbnormalExit(runtime, exitInfo)) return;

    const lastNotification = this.notificationHistory.get(info.sessionId);
    const now = Date.now();
    if (lastNotification && (now - lastNotification) < this.config.cooldownPeriod) return;

    await this.sendCrashNotification({
      sessionId: info.sessionId,
      threadId: info.threadId,
      pid: info.pid,
      exitCode: exitInfo?.exitCode ?? null,
      signal: exitInfo?.signal ?? null,
      timestamp: now,
      lastSeen: info.startTime,
    });

    this.notificationHistory.set(info.sessionId, now);
  }

  private isAbnormalExit(
    runtimeSeconds: number,
    exitInfo: { exitCode?: number; signal?: string } | null,
  ): boolean {
    if (exitInfo?.signal) return true;
    if (exitInfo?.exitCode !== undefined && exitInfo.exitCode !== 0) return true;
    if (runtimeSeconds < this.config.minRuntimeThreshold) return true;
    if (runtimeSeconds > this.config.maxRuntimeThreshold) return true;
    return false;
  }

  // ========== Discord Notifications ==========

  private async sendDiscordMessage(channelId: string, content: string): Promise<void> {
    const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.config.discordToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      throw new Error(`Discord API error: ${response.status} ${response.statusText}`);
    }
  }

  private async sendCrashNotification(notification: CrashNotification): Promise<void> {
    try {
      const runtime = Math.round((notification.timestamp - notification.lastSeen) / 1000);
      const message = this.formatCrashMessage(notification, runtime);
      const channelId = notification.threadId || this.config.generalChannelId;
      await this.sendDiscordMessage(channelId, message);
      console.log(`[ProcessMonitor] Notification sent for session: ${notification.sessionId}`);
    } catch (error: any) {
      console.error('[ProcessMonitor] Failed to send notification:', error.message);
    }
  }

  private formatCrashMessage(notification: CrashNotification, runtime: number): string {
    const time = new Date(notification.timestamp).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });

    let message = `**Claude process exited unexpectedly**\n\n`;
    message += `Time: ${time}\n`;
    message += `Session: \`${notification.sessionId}\`\n`;
    message += `PID: \`${notification.pid}\`\n`;
    if (notification.threadId) message += `Thread: <#${notification.threadId}>\n`;
    message += `Runtime: ${this.formatDuration(runtime)}\n`;
    if (notification.exitCode !== null) message += `Exit code: \`${notification.exitCode}\`\n`;
    if (notification.signal) message += `Signal: \`${notification.signal}\`\n`;
    return message;
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  // ========== Service Monitoring ==========

  private initServiceMonitoring(services: string[]): void {
    for (const service of services) {
      this.trackedServices.set(service, {
        name: service,
        isActive: true,
        lastChecked: Date.now(),
        failureCount: 0,
      });
    }
    console.log(`[ServiceMonitor] Initialized monitoring for: ${services.join(', ')}`);
  }

  private async checkServiceStatus(serviceName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`systemctl --user is-active ${serviceName}`);
      return stdout.trim() === 'active';
    } catch {
      return false;
    }
  }

  private async checkServices(): Promise<void> {
    for (const [serviceName, serviceInfo] of this.trackedServices.entries()) {
      const isActive = await this.checkServiceStatus(serviceName);
      const now = Date.now();
      serviceInfo.lastChecked = now;

      if (!isActive && serviceInfo.isActive) {
        serviceInfo.isActive = false;
        serviceInfo.failureCount++;
        serviceInfo.lastFailureTime = now;
        console.log(`[ServiceMonitor] Service ${serviceName} failed! Count: ${serviceInfo.failureCount}`);
        await this.sendServiceNotification({ serviceName, status: 'failed', timestamp: now, failureCount: serviceInfo.failureCount });
      } else if (isActive && !serviceInfo.isActive) {
        serviceInfo.isActive = true;
        console.log(`[ServiceMonitor] Service ${serviceName} recovered!`);
        await this.sendServiceNotification({ serviceName, status: 'recovered', timestamp: now, failureCount: serviceInfo.failureCount });
        serviceInfo.failureCount = 0;
        serviceInfo.lastFailureTime = undefined;
      }
    }
  }

  private async sendServiceNotification(notification: ServiceNotification): Promise<void> {
    try {
      const message = this.formatServiceMessage(notification);
      await this.sendDiscordMessage(this.config.generalChannelId, message);
      console.log(`[ServiceMonitor] Notification sent: ${notification.serviceName} (${notification.status})`);
    } catch (error: any) {
      console.error('[ServiceMonitor] Failed to send notification:', error.message);
    }
  }

  private formatServiceMessage(notification: ServiceNotification): string {
    const time = new Date(notification.timestamp).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });

    if (notification.status === 'failed') {
      let msg = `**Service Down**\n\n`;
      msg += `Time: ${time}\n`;
      msg += `Service: \`${notification.serviceName}\`\n`;
      msg += `Status: stopped\n`;
      msg += `Failure count: ${notification.failureCount}\n`;
      if (notification.message) msg += `Details: ${notification.message}\n`;
      msg += `\nCheck logs: \`journalctl --user -u ${notification.serviceName} -n 50\``;
      return msg;
    } else {
      let msg = `**Service Recovered**\n\n`;
      msg += `Time: ${time}\n`;
      msg += `Service: \`${notification.serviceName}\`\n`;
      msg += `Status: running\n`;
      if (notification.failureCount > 0) msg += `Previous failures: ${notification.failureCount}\n`;
      return msg;
    }
  }
}
