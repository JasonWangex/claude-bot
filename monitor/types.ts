/**
 * 进程监控守护进程类型定义
 */

export interface ProcessInfo {
  pid: number;
  sessionId: string;
  topicId?: number;
  startTime: number;
}

export interface MonitorConfig {
  telegramToken: string;
  authorizedChatId: number;
  checkInterval: number;           // 检查间隔（毫秒）
  cooldownPeriod: number;          // 冷却期（毫秒）
  minRuntimeThreshold: number;     // 最小运行时间阈值（秒）- 低于此值视为异常
  maxRuntimeThreshold: number;     // 最大运行时间阈值（秒）- 超过此值视为超时
  proxyUrl?: string;
}

export interface CrashNotification {
  sessionId: string;
  topicId?: number;
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
