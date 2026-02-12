/**
 * 简单的日志工具
 */

export const logger = {
  info: (message: string, ...args: any[]) => {
    console.log(`[DC-INFO] ${new Date().toISOString()} ${message}`, ...args);
  },

  error: (message: string, ...args: any[]) => {
    console.error(`[DC-ERROR] ${new Date().toISOString()} ${message}`, ...args);
  },

  warn: (message: string, ...args: any[]) => {
    console.warn(`[DC-WARN] ${new Date().toISOString()} ${message}`, ...args);
  },

  debug: (message: string, ...args: any[]) => {
    if (process.env.DEBUG) {
      console.log(`[DC-DEBUG] ${new Date().toISOString()} ${message}`, ...args);
    }
  },
};
