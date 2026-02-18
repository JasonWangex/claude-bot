import { openSync, readSync, closeSync } from 'fs';
import { basename } from 'path';

export interface SessionMetadata {
  fileSessionId: string;        // 从文件名提取（主标识）
  cwd?: string;                 // 工作目录
  model?: string;               // Claude 模型
  gitBranch?: string;           // git 分支
  version?: string;             // Claude CLI 版本
  timestamp?: string;           // ISO-8601 时间
  permissionMode?: string;      // 权限模式
  firstUserMessage?: string;    // 第一条用户消息（用于生成 title）
}

const BUFFER_SIZE = 16384; // 16KB — 覆盖更多 assistant 事件以获取 model

/**
 * 从 JSONL 文件提取会话元数据
 *
 * 读取策略：openSync + readSync 读取前 16KB → 按行解析 → 收集所有可用元数据
 * 不读取整个文件（可能很大），只取头部。
 *
 * @param jsonlPath 文件绝对路径
 * @returns 元数据（agent 文件返回 null）
 */
export function extractSessionMetadata(jsonlPath: string): SessionMetadata | null {
  // 从文件名提取 session ID（去掉 .jsonl 后缀）
  const fileName = basename(jsonlPath, '.jsonl');

  // 跳过 agent 子任务文件（不需要独立入库）
  if (fileName.startsWith('agent-')) {
    return null;
  }

  let fd: number | null = null;
  try {
    // 打开文件并读取前 16KB
    fd = openSync(jsonlPath, 'r');
    const buffer = Buffer.alloc(BUFFER_SIZE);
    const bytesRead = readSync(fd, buffer, 0, BUFFER_SIZE, 0);

    if (bytesRead === 0) {
      return null; // 空文件
    }

    const content = buffer.toString('utf8', 0, bytesRead);
    const lines = content.split('\n').filter(line => line.trim());

    const metadata: SessionMetadata = { fileSessionId: fileName };

    // 逐行解析 JSON 事件，收集尽可能多的元数据
    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // 从 type: "queue-operation" 提取 timestamp
        if (event.type === 'queue-operation') {
          if (!metadata.timestamp && event.timestamp) {
            metadata.timestamp = event.timestamp;
          }
        }

        // 从 type: "user" 提取完整元数据
        if (event.type === 'user') {
          if (event.cwd && !metadata.cwd) metadata.cwd = event.cwd;
          if (event.version && !metadata.version) metadata.version = event.version;
          if (event.gitBranch && !metadata.gitBranch) metadata.gitBranch = event.gitBranch;
          if (event.timestamp && !metadata.timestamp) metadata.timestamp = event.timestamp;
          if (event.permissionMode && !metadata.permissionMode) metadata.permissionMode = event.permissionMode;

          // 提取第一条用户消息内容（用于生成 title）
          if (!metadata.firstUserMessage && event.message?.content) {
            const content = event.message.content;
            if (typeof content === 'string') {
              metadata.firstUserMessage = content.slice(0, 200);
            } else if (Array.isArray(content)) {
              // Messages API 格式: content block 数组
              const textBlock = content.find((b: any) => b.type === 'text');
              if (textBlock?.text) {
                metadata.firstUserMessage = textBlock.text.slice(0, 200);
              }
            }
          }
        }

        // 从 type: "system", subtype: "local_command" 提取元数据
        if (event.type === 'system' && event.subtype === 'local_command') {
          if (event.cwd && !metadata.cwd) metadata.cwd = event.cwd;
          if (event.version && !metadata.version) metadata.version = event.version;
          if (event.gitBranch && !metadata.gitBranch) metadata.gitBranch = event.gitBranch;
        }

        // 从 type: "assistant" 提取模型
        if (event.type === 'assistant' && event.message?.model) {
          if (!metadata.model) {
            metadata.model = event.message.model;
          }
        }

        // 所有关键字段都已获取时才提前退出
        if (metadata.cwd && metadata.model && metadata.timestamp && metadata.firstUserMessage) {
          break;
        }
      } catch (e) {
        // JSON 解析失败（文件可能正在写入），跳过该行
        continue;
      }
    }

    return metadata;

  } catch (e) {
    // 文件不存在或读取失败
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (e) {
        // 忽略关闭错误
      }
    }
  }
}
