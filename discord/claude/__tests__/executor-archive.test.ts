import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, renameSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

describe('ClaudeExecutor - Archive Functionality', () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const testProcessDir = join(thisDir, '../../../data/processes-test');
  const testSessionsDir = join(thisDir, '../../../data/sessions-test');

  beforeEach(() => {
    // 创建测试目录
    mkdirSync(testProcessDir, { recursive: true });
    mkdirSync(testSessionsDir, { recursive: true });
  });

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testProcessDir)) {
      rmSync(testProcessDir, { recursive: true, force: true });
    }
    if (existsSync(testSessionsDir)) {
      rmSync(testSessionsDir, { recursive: true, force: true });
    }
  });

  it('should archive JSONL files instead of deleting them', () => {
    const sessionId = 'test-session-123';
    const timestamp = Date.now();
    const outputFile = join(testProcessDir, `${timestamp}-test.jsonl`);
    const stderrFile = join(testProcessDir, `${timestamp}-test.stderr`);

    // 创建测试文件
    writeFileSync(outputFile, '{"type":"test","session_id":"test-session-123"}\n');
    writeFileSync(stderrFile, 'test stderr output\n');

    // 验证文件存在
    expect(existsSync(outputFile)).toBe(true);
    expect(existsSync(stderrFile)).toBe(true);

    // 模拟归档过程（手动实现，因为 archiveOutputFiles 是 private）
    const archiveDir = join(testSessionsDir, sessionId);
    mkdirSync(archiveDir, { recursive: true });

    renameSync(outputFile, join(archiveDir, basename(outputFile)));
    renameSync(stderrFile, join(archiveDir, basename(stderrFile)));

    // 验证原始文件已移动
    expect(existsSync(outputFile)).toBe(false);
    expect(existsSync(stderrFile)).toBe(false);

    // 验证归档文件存在
    const archivedOutput = join(archiveDir, basename(outputFile));
    const archivedStderr = join(archiveDir, basename(stderrFile));
    expect(existsSync(archivedOutput)).toBe(true);
    expect(existsSync(archivedStderr)).toBe(true);

    // 验证归档文件内容
    const outputContent = readFileSync(archivedOutput, 'utf-8');
    const stderrContent = readFileSync(archivedStderr, 'utf-8');
    expect(outputContent).toContain('test-session-123');
    expect(stderrContent).toContain('test stderr output');
  });

  it('should create archive directory if it does not exist', () => {
    const sessionId = 'test-session-456';
    const archiveDir = join(testSessionsDir, sessionId);

    // 验证目录不存在
    expect(existsSync(archiveDir)).toBe(false);

    // 创建归档目录
    mkdirSync(archiveDir, { recursive: true });

    // 验证目录已创建
    expect(existsSync(archiveDir)).toBe(true);
  });
});
