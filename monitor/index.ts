/**
 * Claude 进程监控守护进程入口
 */

import 'dotenv/config';
import { ProcessMonitor } from './process-monitor.js';
import { MonitorConfig } from './types.js';

// 检查必需的环境变量
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('[ProcessMonitor] Error: TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

if (!process.env.AUTHORIZED_CHAT_ID) {
  console.error('[ProcessMonitor] Error: AUTHORIZED_CHAT_ID not set');
  process.exit(1);
}

async function main() {
  try {
    const config: MonitorConfig = {
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      authorizedChatId: parseInt(process.env.AUTHORIZED_CHAT_ID, 10),
      checkInterval: parseInt(process.env.MONITOR_CHECK_INTERVAL || '5000', 10),         // 默认 5 秒
      cooldownPeriod: parseInt(process.env.MONITOR_COOLDOWN || '180000', 10),            // 默认 3 分钟
      minRuntimeThreshold: parseInt(process.env.MONITOR_MIN_RUNTIME || '2', 10),         // 默认 2 秒
      maxRuntimeThreshold: parseInt(process.env.MONITOR_MAX_RUNTIME || '3600', 10),      // 默认 1 小时
      proxyUrl: process.env.https_proxy || process.env.http_proxy
    };

    console.log('[ProcessMonitor] Starting Claude Process Monitor...');
    console.log('[ProcessMonitor] Authorized Chat ID:', config.authorizedChatId);
    console.log('[ProcessMonitor] Check Interval:', config.checkInterval, 'ms');
    console.log('[ProcessMonitor] Cooldown Period:', config.cooldownPeriod, 'ms');

    // 配置要监控的服务列表
    const monitoredServices = (process.env.MONITOR_SERVICES || 'claude-telegram')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    console.log('[ProcessMonitor] Monitored Services:', monitoredServices.join(', '));

    const monitor = new ProcessMonitor(config);
    await monitor.start(monitoredServices);

  } catch (error: any) {
    console.error('[ProcessMonitor] Fatal error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
