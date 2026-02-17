/**
 * Session Reader — 按需从 Claude CLI session .jsonl 文件流式读取会话数据
 *
 * 目的：不再维护内存消息缓存，改为从 ~/.claude/projects/xxx/*.jsonl 文件直接读取
 *
 * 功能：
 * 1. 根据 claudeSessionId 查找对应的 .jsonl 文件
 * 2. 流式读取文件内容（逐行解析 JSONL）
 * 3. 提供结构化的交互事件序列
 */

import { readdirSync, statSync, readFileSync, createReadStream } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

/** JSONL 事件类型（精简版） */
export interface SessionEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'queue-operation';
  subtype?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  parent_tool_use_id?: string;
  total_cost_usd?: number;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  permissionMode?: string;
}

/**
 * 从 claudeProjectsDir 查找包含指定 sessionId 的 .jsonl 文件
 *
 * @param claudeProjectsDir ~/.claude/projects 目录路径
 * @param claudeSessionId Claude CLI session UUID
 * @returns .jsonl 文件绝对路径，找不到返回 null
 */
export function findSessionJsonlFile(
  claudeProjectsDir: string,
  claudeSessionId: string,
): string | null {
  try {
    // 遍历所有项目目录
    const projectDirs = readdirSync(claudeProjectsDir)
      .map((entry) => join(claudeProjectsDir, entry))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });

    for (const projectDir of projectDirs) {
      try {
        const entries = readdirSync(projectDir);

        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) {
            continue;
          }

          const filePath = join(projectDir, entry);

          try {
            // 检查文件是否存在且可读
            const stat = statSync(filePath);
            if (!stat.isFile()) {
              continue;
            }

            // 检查文件名是否包含 sessionId（快速过滤）
            if (entry.includes(claudeSessionId)) {
              return filePath;
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 流式读取 .jsonl 文件，逐行解析并通过回调返回事件
 *
 * @param jsonlPath .jsonl 文件绝对路径
 * @param onEvent 每解析一行调用一次的回调函数
 * @param onEnd 读取完成后调用的回调函数
 * @param onError 读取错误时调用的回调函数
 */
export function streamSessionEvents(
  jsonlPath: string,
  onEvent: (event: SessionEvent) => void,
  onEnd: () => void,
  onError: (error: Error) => void,
): void {
  try {
    const fileStream = createReadStream(jsonlPath, { encoding: 'utf8' });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed) as SessionEvent;
        onEvent(event);
      } catch (e) {
        // 单行解析失败，跳过（文件可能正在写入）
      }
    });

    rl.on('close', () => {
      onEnd();
    });

    rl.on('error', (error) => {
      onError(error);
    });
  } catch (error: any) {
    onError(error);
  }
}

/**
 * 同步读取整个 .jsonl 文件并返回所有事件（用于小文件或调试）
 *
 * @param jsonlPath .jsonl 文件绝对路径
 * @returns 所有事件数组
 */
export function readSessionEventsSync(jsonlPath: string): SessionEvent[] {
  try {
    const content = readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim());
    const events: SessionEvent[] = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        // 跳过损坏的行
      }
    }

    return events;
  } catch (e) {
    return [];
  }
}
