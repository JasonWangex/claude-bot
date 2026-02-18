import type Database from 'better-sqlite3';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { extractSessionMetadata } from './jsonl-metadata.js';
import { ClaudeSessionRepository } from '../db/repo/claude-session-repo.js';
import { SyncCursorRepository } from '../db/repo/sync-cursor-repo.js';
import { ChannelRepository } from '../db/repo/channel-repo.js';
import type { ClaudeSession } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { generateSessionTitle } from '../utils/llm.js';

const SCAN_INTERVAL_MS = 60_000; // 60 seconds
const CURSOR_SOURCE = 'claude_session_scan';

export class SessionSyncService {
  private scanTimer: NodeJS.Timeout | null = null;
  private claudeSessionRepo: ClaudeSessionRepository;
  private syncCursorRepo: SyncCursorRepository;
  private channelRepo: ChannelRepository;

  /** 待 LLM 生成 title 的队列 */
  private pendingTitles: Array<{ sessionId: string; firstUserMessage: string }> = [];
  private titleGenerationRunning = false;

  constructor(
    private db: Database.Database,
    private claudeProjectsDir: string,  // 默认 ~/.claude/projects
  ) {
    this.claudeSessionRepo = new ClaudeSessionRepository(db);
    this.syncCursorRepo = new SyncCursorRepository(db);
    this.channelRepo = new ChannelRepository(db);
  }

  /** 启动定时扫描（60s 间隔） */
  start(): void {
    if (this.scanTimer) {
      logger.warn('SessionSyncService already started');
      return;
    }

    logger.info(`Starting Claude session sync service (scan interval: ${SCAN_INTERVAL_MS}ms)`);

    // 检查是否有 cursor，没有则先做全量同步
    const cursors = this.syncCursorRepo.loadAll();
    if (!cursors.has(CURSOR_SOURCE)) {
      logger.info('No sync cursor found, running initial full sync...');
      this.syncAll();
    }

    // 启动定时扫描
    this.scanTimer = setInterval(() => {
      this.scanForChanges();
    }, SCAN_INTERVAL_MS);
  }

  /** 停止定时扫描 */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      logger.info('SessionSyncService stopped');
    }
  }

  /** 实时同步单个会话（execute 回调调用） */
  async syncSession(claudeSessionId: string, channelId?: string, model?: string): Promise<void> {
    try {
      // 查询是否已有记录
      const existing = await this.claudeSessionRepo.findByClaudeSessionId(claudeSessionId);

      if (!existing) {
        // 创建新记录
        const newSession: ClaudeSession = {
          id: randomUUID(),
          claudeSessionId,
          channelId,
          model,
          planMode: false,
          status: 'active',
          createdAt: Date.now(),
          purpose: channelId ? 'channel' : 'temp',  // 有 channel 为 channel，否则为临时
        };
        await this.claudeSessionRepo.save(newSession);
        logger.info(`Claude session created: ${claudeSessionId.slice(0, 8)}... (channel: ${channelId || 'none'})`);
      } else {
        // 更新现有记录（仅在有新信息时）
        let updated = false;

        if (model && model !== existing.model) {
          existing.model = model;
          updated = true;
        }

        if (channelId && channelId !== existing.channelId) {
          existing.channelId = channelId;
          updated = true;
        }

        if (updated) {
          await this.claudeSessionRepo.save(existing);
          logger.info(`Claude session updated: ${claudeSessionId.slice(0, 8)}...`);
        }
      }
    } catch (e: any) {
      logger.error(`Failed to sync session ${claudeSessionId}: ${e.message}`);
    }
  }

  /** 关闭会话（进程被中止/杀死时调用） */
  async closeSession(claudeSessionId: string): Promise<void> {
    try {
      const existing = await this.claudeSessionRepo.findByClaudeSessionId(claudeSessionId);
      if (!existing) {
        logger.warn(`Cannot close session ${claudeSessionId}: not found`);
        return;
      }

      // 调用 repository 的 close 方法
      const closed = await this.claudeSessionRepo.close(existing.id);
      if (closed) {
        logger.info(`Claude session closed: ${claudeSessionId.slice(0, 8)}...`);
      }
    } catch (e: any) {
      logger.error(`Failed to close session ${claudeSessionId}: ${e.message}`);
    }
  }

  /** 全量同步（API 调用），返回统计信息 */
  syncAll(): { discovered: number; created: number; updated: number } {
    const stats = { discovered: 0, created: 0, updated: 0 };

    try {
      // 遍历所有项目目录
      const projectDirs = this.listProjectDirs();

      for (const projectDir of projectDirs) {
        const jsonlFiles = this.listJsonlFiles(projectDir);

        for (const jsonlFile of jsonlFiles) {
          stats.discovered++;
          const result = this.processJsonlFileSync(jsonlFile);
          if (result === 'created') {
            stats.created++;
          } else if (result === 'updated') {
            stats.updated++;
          }
        }
      }

      // 更新游标为当前时间
      this.syncCursorRepo.set(CURSOR_SOURCE, String(Date.now()));

      logger.info(`Full sync completed: ${stats.discovered} files, ${stats.created} created, ${stats.updated} updated`);

      // 异步生成缺失的 title（fire-and-forget）
      this.processPendingTitles();
    } catch (e: any) {
      logger.error(`Full sync failed: ${e.message}`);
    }

    return stats;
  }

  /** 定时扫描（内部调用） */
  private async scanForChanges(): Promise<void> {
    try {
      // 读取游标
      const cursorStr = await this.syncCursorRepo.get(CURSOR_SOURCE);
      if (!cursorStr) {
        // 首次运行，跳过扫描（等用户调 syncAll 或 execute 回调填充）
        logger.debug('No sync cursor found, skipping incremental scan');
        return;
      }

      const cursorMs = parseInt(cursorStr, 10);
      if (isNaN(cursorMs)) {
        logger.warn(`Invalid cursor value: ${cursorStr}`);
        return;
      }

      let processedCount = 0;
      const projectDirs = this.listProjectDirs();

      for (const projectDir of projectDirs) {
        const jsonlFiles = this.listJsonlFiles(projectDir, cursorMs);

        for (const jsonlFile of jsonlFiles) {
          this.processJsonlFileSync(jsonlFile);
          processedCount++;
        }
      }

      // 更新游标
      await this.syncCursorRepo.set(CURSOR_SOURCE, String(Date.now()));

      if (processedCount > 0) {
        logger.info(`Incremental scan: ${processedCount} files processed`);
      }

      // 异步生成缺失的 title（fire-and-forget）
      this.processPendingTitles();
    } catch (e: any) {
      logger.error(`Scan failed: ${e.message}`);
    }
  }

  /** 处理单个 JSONL 文件 */
  private processJsonlFileSync(jsonlPath: string): 'created' | 'updated' | 'skipped' {
    try {
      // 提取元数据（agent 文件会返回 null）
      const metadata = extractSessionMetadata(jsonlPath);
      if (!metadata) {
        return 'skipped';
      }

      const claudeSessionId = metadata.fileSessionId;

      // 查询是否已有记录
      const stmt = this.db.prepare('SELECT * FROM claude_sessions WHERE claude_session_id = ?');
      const existingRow = stmt.get(claudeSessionId) as any;

      // 查找对应的 channel（通过 cwd 匹配）
      let channelId: string | undefined;
      if (metadata.cwd) {
        const channels = this.channelRepo.loadAll();
        const matchedChannel = channels.find(ch => ch.cwd === metadata.cwd);
        channelId = matchedChannel?.id;
      }

      if (!existingRow) {
        // 创建新记录
        const id = randomUUID();
        const newSession: ClaudeSession = {
          id,
          claudeSessionId,
          channelId,
          model: metadata.model,
          planMode: false,
          status: 'active',
          createdAt: metadata.timestamp ? new Date(metadata.timestamp).getTime() : Date.now(),
          purpose: channelId ? 'channel' : 'temp',
        };
        this.claudeSessionRepo.save(newSession);

        // 收集到待生成 title 队列
        if (metadata.firstUserMessage) {
          this.pendingTitles.push({ sessionId: id, firstUserMessage: metadata.firstUserMessage });
        }
        return 'created';
      } else {
        // 检查是否需要更新
        let updated = false;
        const existing: ClaudeSession = {
          id: existingRow.id,
          claudeSessionId: existingRow.claude_session_id ?? undefined,
          prevClaudeSessionId: existingRow.prev_claude_session_id ?? undefined,
          channelId: existingRow.channel_id ?? undefined,
          model: existingRow.model ?? undefined,
          planMode: existingRow.plan_mode === 1,
          status: existingRow.status,
          createdAt: existingRow.created_at,
          closedAt: existingRow.closed_at ?? undefined,
          parentSessionId: existingRow.parent_session_id ?? undefined,
          title: existingRow.title ?? undefined,
        };

        if (metadata.model && metadata.model !== existing.model) {
          existing.model = metadata.model;
          updated = true;
        }

        if (channelId && channelId !== existing.channelId) {
          existing.channelId = channelId;
          updated = true;
        }

        if (updated) {
          this.claudeSessionRepo.save(existing);
        }

        // 补填缺失的 title
        if (!existing.title && metadata.firstUserMessage) {
          this.pendingTitles.push({ sessionId: existing.id, firstUserMessage: metadata.firstUserMessage });
        }

        return updated ? 'updated' : 'skipped';
      }
    } catch (e: any) {
      logger.warn(`Failed to process ${jsonlPath}: ${e.message}`);
      return 'skipped';
    }
  }

  /** 列出所有项目目录 */
  private listProjectDirs(): string[] {
    try {
      const entries = readdirSync(this.claudeProjectsDir);
      return entries
        .map(entry => join(this.claudeProjectsDir, entry))
        .filter(path => {
          try {
            return statSync(path).isDirectory();
          } catch {
            return false;
          }
        });
    } catch (e: any) {
      logger.warn(`Failed to list project dirs: ${e.message}`);
      return [];
    }
  }

  /** 列出目录下的 JSONL 文件（可选：仅返回 mtime > cursorMs 的） */
  private listJsonlFiles(projectDir: string, cursorMs?: number): string[] {
    try {
      const entries = readdirSync(projectDir);
      const jsonlFiles: string[] = [];

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) {
          continue;
        }

        const filePath = join(projectDir, entry);
        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) {
            continue;
          }

          // 如果指定了游标，只处理更新的文件
          if (cursorMs !== undefined && stat.mtimeMs <= cursorMs) {
            continue;
          }

          jsonlFiles.push(filePath);
        } catch {
          // 单个文件 stat 失败，跳过
          continue;
        }
      }

      return jsonlFiles;
    } catch (e: any) {
      logger.warn(`Failed to list JSONL files in ${projectDir}: ${e.message}`);
      return [];
    }
  }

  /** 异步批量生成缺失的 session title（通过 LLM） */
  private async processPendingTitles(): Promise<void> {
    if (this.titleGenerationRunning || this.pendingTitles.length === 0) return;

    this.titleGenerationRunning = true;
    const batch = this.pendingTitles.splice(0);
    let generated = 0;

    try {
      for (const { sessionId, firstUserMessage } of batch) {
        try {
          const title = await generateSessionTitle(firstUserMessage);
          // 直接用 SQL 更新 title（仅当 title 为 null 时）
          this.db.prepare(
            `UPDATE claude_sessions SET title = ? WHERE id = ? AND title IS NULL`,
          ).run(title, sessionId);
          generated++;
        } catch (e: any) {
          logger.warn(`Failed to generate title for session ${sessionId}: ${e.message}`);
        }
      }
      if (generated > 0) {
        logger.info(`Generated ${generated} session titles`);
      }
    } finally {
      this.titleGenerationRunning = false;
    }
  }
}
