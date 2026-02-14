import { openSync, readSync, closeSync } from 'fs';

export interface SessionMetadata {
  sessionId: string;              // Claude CLI session UUID
  cwd?: string;                   // 工作目录
  model?: string;                 // Claude 模型
  gitBranch?: string;             // git 分支
  version?: string;               // Claude CLI 版本
  timestamp?: string;             // ISO-8601 时间
  permissionMode?: string;        // 权限模式
}

/**
 * 从 JSONL 文件提取会话元数据
 *
 * 读取策略：openSync + readSync 读取前 8KB → 按行解析 → 找到含 sessionId 的事件即停止
 * 不读取整个文件（可能很大），只取头部。
 */
export function extractSessionMetadata(jsonlPath: string): SessionMetadata | null {
  let fd: number | null = null;
  try {
    // 打开文件并读取前 8KB
    fd = openSync(jsonlPath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytesRead = readSync(fd, buffer, 0, 8192, 0);

    if (bytesRead === 0) {
      return null; // 空文件
    }

    const content = buffer.toString('utf8', 0, bytesRead);
    const lines = content.split('\n').filter(line => line.trim());

    const metadata: SessionMetadata = { sessionId: '' };

    // 逐行解析 JSON 事件
    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // 从 type: "queue-operation" 提取 sessionId 和 timestamp
        if (event.type === 'queue-operation' && event.sessionId) {
          if (!metadata.sessionId) {
            metadata.sessionId = event.sessionId;
          }
          if (!metadata.timestamp && event.timestamp) {
            metadata.timestamp = event.timestamp;
          }
        }

        // 从 type: "user" 提取完整元数据
        if (event.type === 'user') {
          if (event.sessionId) metadata.sessionId = event.sessionId;
          if (event.cwd) metadata.cwd = event.cwd;
          if (event.version) metadata.version = event.version;
          if (event.gitBranch) metadata.gitBranch = event.gitBranch;
          if (event.timestamp) metadata.timestamp = event.timestamp;
          if (event.permissionMode) metadata.permissionMode = event.permissionMode;
        }

        // 从 type: "system", subtype: "local_command" 提取元数据
        if (event.type === 'system' && event.subtype === 'local_command') {
          if (event.sessionId && !metadata.sessionId) {
            metadata.sessionId = event.sessionId;
          }
          if (event.cwd && !metadata.cwd) {
            metadata.cwd = event.cwd;
          }
          if (event.version && !metadata.version) {
            metadata.version = event.version;
          }
          if (event.gitBranch && !metadata.gitBranch) {
            metadata.gitBranch = event.gitBranch;
          }
        }

        // 从 type: "assistant" 提取模型
        if (event.type === 'assistant' && event.message?.model) {
          if (!metadata.model) {
            metadata.model = event.message.model;
          }
        }

        // 如果已获取 sessionId 且有基本信息，可以提前返回
        if (metadata.sessionId && (metadata.cwd || metadata.timestamp)) {
          break;
        }
      } catch (e) {
        // JSON 解析失败（文件可能正在写入），跳过该行
        continue;
      }
    }

    // 必须至少有 sessionId 才返回有效结果
    return metadata.sessionId ? metadata : null;

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
