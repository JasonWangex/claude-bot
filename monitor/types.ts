/**
 * 进程监控守护进程类型定义
 */

export interface ProcessInfo {
  pid: number;
  sessionId: string;
  threadId?: string;
  startTime: number;
}

export interface MonitorConfig {
  discordToken: string;
  generalChannelId: string;
  checkInterval: number;
  cooldownPeriod: number;
  minRuntimeThreshold: number;
  maxRuntimeThreshold: number;
}

export interface CrashNotification {
  sessionId: string;
  threadId?: string;
  pid: number;
  exitCode: number | null;
  signal: string | null;
  timestamp: number;
  lastSeen: number;
}

export interface ServiceInfo {
  name: string;
  isActive: boolean;
  lastChecked: number;
  failureCount: number;
  lastFailureTime?: number;
}

export interface ServiceNotification {
  serviceName: string;
  status: 'failed' | 'recovered';
  timestamp: number;
  failureCount: number;
  message?: string;
}
