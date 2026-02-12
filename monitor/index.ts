/**
 * Claude 进程监控守护进程入口（Discord 版）
 */

import 'dotenv/config';
import { ProcessMonitor } from './process-monitor.js';
import { MonitorConfig } from './types.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('[ProcessMonitor] Error: DISCORD_TOKEN not set');
  process.exit(1);
}

if (!process.env.GENERAL_CHANNEL_ID) {
  console.error('[ProcessMonitor] Error: GENERAL_CHANNEL_ID not set');
  process.exit(1);
}

async function main() {
  try {
    const config: MonitorConfig = {
      discordToken: process.env.DISCORD_TOKEN!,
      generalChannelId: process.env.GENERAL_CHANNEL_ID!,
      checkInterval: parseInt(process.env.MONITOR_CHECK_INTERVAL || '5000', 10),
      cooldownPeriod: parseInt(process.env.MONITOR_COOLDOWN || '180000', 10),
      minRuntimeThreshold: parseInt(process.env.MONITOR_MIN_RUNTIME || '2', 10),
      maxRuntimeThreshold: parseInt(process.env.MONITOR_MAX_RUNTIME || '3600', 10),
    };

    console.log('[ProcessMonitor] Starting Claude Process Monitor...');
    console.log('[ProcessMonitor] General Channel ID:', config.generalChannelId);
    console.log('[ProcessMonitor] Check Interval:', config.checkInterval, 'ms');
    console.log('[ProcessMonitor] Cooldown Period:', config.cooldownPeriod, 'ms');

    const monitoredServices = (process.env.MONITOR_SERVICES || 'claude-discord')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    console.log('[ProcessMonitor] Monitored Services:', monitoredServices.join(', '));

    const monitor = new ProcessMonitor(config);
    await monitor.start(monitoredServices);
  } catch (error: any) {
    console.error('[ProcessMonitor] Fatal error:', error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

main();
