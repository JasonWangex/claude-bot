/**
 * Logger 功能测试
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Logger, createLogger, type LogEntry, type LoggerTransport } from '../logger.js';
import { ConsoleTransport } from '../transports/console-transport.js';
import { FileTransport } from '../transports/file-transport.js';

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

  it('should extract stack from Error arg on error level', () => {
    const logger = new Logger();
    const logs: LogEntry[] = [];
    logger.addTransport({ log: (e) => logs.push(e) });

    const err = new Error('something went wrong');
    logger.error('operation failed:', err);

    expect(logs[0].stack).toBeDefined();
    expect(logs[0].stack).toContain('Error: something went wrong');
    expect(logs[0].args[0]).toBe(err);
  });

  it('should not set stack when no Error in args', () => {
    const logger = new Logger();
    const logs: LogEntry[] = [];
    logger.addTransport({ log: (e) => logs.push(e) });

    logger.error('plain error message', 'string arg');

    expect(logs[0].stack).toBeUndefined();
  });

  it('should not extract stack on non-error levels', () => {
    const logger = new Logger();
    const logs: LogEntry[] = [];
    logger.addTransport({ log: (e) => logs.push(e) });

    const err = new Error('warn error');
    logger.warn('something warned:', err);

    expect(logs[0].stack).toBeUndefined();
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

  it('should not pass raw Error to console.error to avoid double stack', () => {
    const transport = new ConsoleTransport(true);
    const calls: any[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => calls.push(args));

    const err = new Error('boom');
    const entry: LogEntry = {
      level: 'error',
      message: 'failed:',
      timestamp: new Date(),
      args: [err],
      stack: err.stack,
    };
    transport.log(entry);
    spy.mockRestore();

    // 第一次 console.error 的参数里不应有 Error 实例（已替换为 message 字符串）
    const firstCallArgs = calls[0];
    const hasErrorInstance = firstCallArgs.some((a) => a instanceof Error);
    expect(hasErrorInstance).toBe(false);
    // 第二次 console.error 应输出 stack
    expect(calls[1][0]).toContain('Error: boom');
  });
});

describe('FileTransport', () => {
  let tmpDir: string;

  const makeTmpTransport = (debugEnabled = false) => {
    tmpDir = mkdtempSync(join(tmpdir(), 'logger-test-'));
    return new FileTransport(join(tmpDir, 'test.log'), debugEnabled);
  };

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write log line to file', () => {
    const transport = makeTmpTransport();
    const logFile = join(tmpDir, 'test.log');

    transport.log({ level: 'info', message: 'hello world', timestamp: new Date(), args: [] });

    const content = readFileSync(logFile, 'utf8');
    expect(content).toContain('[INFO ]');
    expect(content).toContain('hello world');
  });

  it('should append stack trace for error level', () => {
    const transport = makeTmpTransport();
    const logFile = join(tmpDir, 'test.log');

    const err = new Error('db failed');
    transport.log({
      level: 'error',
      message: 'query error:',
      timestamp: new Date(),
      args: [err],
      stack: err.stack,
    });

    const content = readFileSync(logFile, 'utf8');
    expect(content).toContain('[ERROR]');
    // stack 完整输出
    expect(content).toContain('Error: db failed');
    // Error.message 不应在正文行重复（stack 第一行已含）
    const firstLine = content.split('\n')[0];
    expect(firstLine).not.toContain('db failed');
  });

  it('should not throw when log directory cannot be created', () => {
    // 使用一个无效路径名来触发目录创建失败（\0 在路径中是非法字符）
    expect(() => new FileTransport('/\0invalid/path/test.log')).not.toThrow();
  });

  it('should filter debug logs when not enabled', () => {
    const transport = makeTmpTransport(false);
    const logFile = join(tmpDir, 'test.log');

    transport.log({ level: 'debug', message: 'debug msg', timestamp: new Date(), args: [] });

    // debug 被过滤，文件不存在或为空
    let content = '';
    try { content = readFileSync(logFile, 'utf8'); } catch { /* file not created */ }
    expect(content).toBe('');
  });
});
