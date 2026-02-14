/**
 * Logger 功能测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Logger, createLogger, type LogEntry, type LoggerTransport } from '../logger.js';
import { ConsoleTransport } from '../transports/console-transport.js';

describe('Logger', () => {
  it('should create a logger with no transports', () => {
    const logger = new Logger();
    expect(logger).toBeDefined();
  });

  it('should add transports', () => {
    const logger = new Logger();
    const mockTransport: LoggerTransport = {
      log: () => {},
    };
    logger.addTransport(mockTransport);
    // Logger 应该能够正常工作
    logger.info('test message');
  });

  it('should call transport.log when logging', () => {
    const logger = new Logger();
    const logs: LogEntry[] = [];
    const mockTransport: LoggerTransport = {
      log: (entry) => logs.push(entry),
    };

    logger.addTransport(mockTransport);
    logger.info('test info', { foo: 'bar' });
    logger.error('test error');
    logger.warn('test warn');
    logger.debug('test debug');

    expect(logs).toHaveLength(4);
    expect(logs[0].level).toBe('info');
    expect(logs[0].message).toBe('test info');
    expect(logs[0].args).toEqual([{ foo: 'bar' }]);
    expect(logs[1].level).toBe('error');
    expect(logs[2].level).toBe('warn');
    expect(logs[3].level).toBe('debug');
  });
});

describe('createLogger', () => {
  it('should create logger with transports', () => {
    const mockTransport: LoggerTransport = {
      log: () => {},
    };
    const logger = createLogger({
      transports: [mockTransport],
    });
    expect(logger).toBeDefined();
    logger.info('test');
  });

  it('should create logger without options', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
  });
});

describe('ConsoleTransport', () => {
  it('should create ConsoleTransport', () => {
    const transport = new ConsoleTransport();
    expect(transport).toBeDefined();
  });

  it('should filter debug logs when not enabled', () => {
    const transport = new ConsoleTransport(false);
    const entry: LogEntry = {
      level: 'debug',
      message: 'test',
      timestamp: new Date(),
      args: [],
    };
    // 应该不会抛出错误
    transport.log(entry);
  });

  it('should log debug logs when enabled', () => {
    const transport = new ConsoleTransport(true);
    const entry: LogEntry = {
      level: 'debug',
      message: 'test',
      timestamp: new Date(),
      args: [],
    };
    // 应该不会抛出错误
    transport.log(entry);
  });
});
