/**
 * 简单的日志工具
 */

export const logger = {
  info: (message: string, ...args: any[]) => {
    console.log(`[TG-INFO] ${new Date().toISOString()} ${message}`, ...args);
  },

  error: (message: string, ...args: any[]) => {
    console.error(`[TG-ERROR] ${new Date().toISOString()} ${message}`, ...args);
  },

  warn: (message: string, ...args: any[]) => {
    console.warn(`[TG-WARN] ${new Date().toISOString()} ${message}`, ...args);
  },

  debug: (message: string, ...args: any[]) => {
    if (process.env.DEBUG) {
      console.log(`[TG-DEBUG] ${new Date().toISOString()} ${message}`, ...args);
    }
  },

  user: (userId: number, message: string, ...args: any[]) => {
    console.log(`[TG-USER ${userId}] ${new Date().toISOString()} ${message}`, ...args);
  },
};
