import type Database from 'better-sqlite3';
import { closeSync, createReadStream, openSync, readdirSync, readSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createInterface } from 'readline';
import { ChannelRepository } from '../db/repo/channel-repo.js';
import { ClaudeSessionRepository } from '../db/repo/claude-session-repo.js';
import { SyncCursorRepository } from '../db/repo/sync-cursor-repo.js';
import type { PromptConfigService } from '../services/prompt-config-service.js';
import type { ClaudeSession } from '../types/index.js';
import { chatCompletion } from '../utils/llm.js';
import { logger } from '../utils/logger.js';
import { extractSessionMetadata } from './jsonl-metadata.js';
import type { PricingService } from './pricing-service.js';
import { decodeProjectDirName, resolveSessionContext } from './session-context.js';

const SCAN_INTERVAL_MS = 60_000; // 60 seconds
const CURSOR_SOURCE = 'claude_session_scan';
const FIRST_MSG_BUFFER_SIZE = 32768; // 32KB — 第一条用户消息可能较远
const FIRST_MSG_MAX_CHARS = 500;     // 截取前 500 字符给 LLM
const TITLE_MAX_CHARS = 30;

/**
 * 从 JSONL 文件路径提取 Claude 项目路径
 *
 * 取 JSONL 所在目录名，用文件系统贪心解码还原为真实路径。
 */
function projectPathFromJsonl(jsonlPath: string): string {
  const dirName = basename(dirname(jsonlPath));
  return decodeProjectDirName(dirName);
}

interface ModelStats {
  tokensIn: number;
  tokensOut: number;
  cacheReadIn: number;
  cacheWriteIn: number;
  costUsd: number;
  turnCount: number;
}

interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheReadIn: number;
  cacheWriteIn: number;
  costUsd: number;
  turnCount: number;
  byModel: Record<string, ModelStats>;
}

export class SessionSyncService {
  private scanTimer: NodeJS.Timeout | null = null;
  private claudeSessionRepo: ClaudeSessionRepository;
  private syncCursorRepo: SyncCursorRepository;
  private channelRepo: ChannelRepository;
  private promptService: PromptConfigService | null = null;
  private pricingService: PricingService | null = null;
  /** 序列化同一 claudeSessionId 的并发 syncSession 调用，避免重复 INSERT */
  private syncSessionLocks: Map<string, Promise<void>> = new Map();
  /** 全量覆盖写 usage 的预编译 SQL */
  private usageOverwriteStmt: Database.Statement;

  constructor(
    private db: Database.Database,
    private claudeProjectsDir: string,  // 默认 ~/.claude/projects
    pricingService?: PricingService,
  ) {
    this.claudeSessionRepo = new ClaudeSessionRepository(db);
    this.syncCursorRepo = new SyncCursorRepository(db);
    this.channelRepo = new ChannelRepository(db);
    this.pricingService = pricingService ?? null;

    this.usageOverwriteStmt = db.prepare(`
      UPDATE claude_sessions SET
        tokens_in         = ?,
        tokens_out        = ?,
        cache_read_in     = ?,
        cache_write_in    = ?,
        cost_usd          = ?,
        turn_count        = ?,
        usage_file_offset = ?,
        model_usage       = ?
      WHERE claude_session_id = ?
    `);
  }

  /** 注入 PromptConfigService（启动后调用） */
  setPromptService(promptService: PromptConfigService): void {
    this.promptService = promptService;
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
    // 序列化同一 session 的并发调用：等待上一次调用完成后再执行
    const prev = this.syncSessionLocks.get(claudeSessionId) ?? Promise.resolve();
    const current = prev.then(() => this._doSyncSession(claudeSessionId, channelId, model));
    const guard = current.catch(() => { });
    this.syncSessionLocks.set(claudeSessionId, guard);
    // 完成后清理，避免 Map 无限增长
    guard.then(() => {
      if (this.syncSessionLocks.get(claudeSessionId) === guard) {
        this.syncSessionLocks.delete(claudeSessionId);
      }
    });
    return current;
  }

  private async _doSyncSession(claudeSessionId: string, channelId?: string, model?: string): Promise<void> {
    try {
      // 查询是否已有记录（PK = claudeSessionId）
      const existing = await this.claudeSessionRepo.get(claudeSessionId);

      if (!existing) {
        // 创建新记录
        const ctx = resolveSessionContext(this.db, channelId);
        const newSession: ClaudeSession = {
          claudeSessionId,
          channelId,
          model,
          planMode: false,
          status: 'active',
          createdAt: Date.now(),
          purpose: channelId ? 'channel' : 'temp',
          taskId: ctx.taskId ?? undefined,
          goalId: ctx.goalId ?? undefined,
          cwd: ctx.cwd ?? undefined,
          gitBranch: ctx.gitBranch ?? undefined,
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

        // 补充缺失的 context
        if (!existing.taskId && channelId) {
          const ctx = resolveSessionContext(this.db, channelId);
          if (ctx.taskId) {
            existing.taskId = ctx.taskId;
            existing.goalId = ctx.goalId ?? undefined;
            existing.cwd = existing.cwd ?? ctx.cwd ?? undefined;
            existing.gitBranch = existing.gitBranch ?? ctx.gitBranch ?? undefined;
            updated = true;
          }
        }

        if (updated) {
          await this.claudeSessionRepo.save(existing);
          logger.info(`Claude session updated: ${claudeSessionId.slice(0, 8)}...`);
        }
      }
    } catch (e: any) {
      logger.error(`Failed to sync session ${claudeSessionId}:`, e);
    }
  }

  /** 关闭会话（进程被中止/杀死时调用） */
  async closeSession(claudeSessionId: string): Promise<void> {
    try {
      const closed = await this.claudeSessionRepo.close(claudeSessionId);
      if (closed) {
        logger.info(`Claude session closed: ${claudeSessionId.slice(0, 8)}...`);
      } else {
        logger.warn(`Cannot close session ${claudeSessionId}: not found`);
      }
    } catch (e: any) {
      logger.error(`Failed to close session ${claudeSessionId}:`, e);
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
          // 增量 usage（异步，不阻塞循环）
          if (this.pricingService) {
            void this.processUsageDelta(jsonlFile);
          }
        }
      }

      // 更新游标为当前时间
      this.syncCursorRepo.set(CURSOR_SOURCE, String(Date.now()));

      logger.info(`Full sync completed: ${stats.discovered} files, ${stats.created} created, ${stats.updated} updated`);

      // 异步补充缺失的 title
      void this.backfillTitles();
    } catch (e: any) {
      logger.error('Full sync failed:', e);
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
          // 增量 usage（异步，不阻塞循环）
          if (this.pricingService) {
            void this.processUsageDelta(jsonlFile);
          }
        }
      }

      // 更新游标
      await this.syncCursorRepo.set(CURSOR_SOURCE, String(Date.now()));

      if (processedCount > 0) {
        logger.info(`Incremental scan: ${processedCount} files processed`);
      }
    } catch (e: any) {
      logger.error('Scan failed:', e);
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

      // 获取文件时间戳
      const fileStat = statSync(jsonlPath);
      const fileMtimeMs = Math.floor(fileStat.mtimeMs);
      const fileBirthtimeMs = Math.floor(fileStat.birthtimeMs);

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

      // created_at: 优先用事件时间戳，fallback 用文件 birthtime
      const createdAt = metadata.timestamp
        ? new Date(metadata.timestamp).getTime()
        : fileBirthtimeMs;

      const projectPath = projectPathFromJsonl(jsonlPath);

      if (!existingRow) {
        // 创建新记录
        const ctx = resolveSessionContext(this.db, channelId);
        const newSession: ClaudeSession = {
          claudeSessionId,
          channelId,
          model: metadata.model,
          planMode: false,
          status: 'active',
          createdAt,
          lastActivityAt: fileMtimeMs,
          purpose: channelId ? 'channel' : 'temp',
          taskId: ctx.taskId ?? undefined,
          goalId: ctx.goalId ?? undefined,
          cwd: metadata.cwd ?? ctx.cwd ?? undefined,
          gitBranch: ctx.gitBranch ?? undefined,
          projectPath,
        };
        this.claudeSessionRepo.save(newSession);

        // 异步生成 title（不阻塞同步流程）
        void this.generateAndSaveTitle(claudeSessionId, jsonlPath);

        return 'created';
      } else {
        // 检查是否需要更新
        let updated = false;
        const existing: ClaudeSession = {
          claudeSessionId: existingRow.claude_session_id,
          prevClaudeSessionId: existingRow.prev_claude_session_id ?? undefined,
          channelId: existingRow.channel_id ?? undefined,
          model: existingRow.model ?? undefined,
          planMode: existingRow.plan_mode === 1,
          status: existingRow.status,
          createdAt: existingRow.created_at,
          closedAt: existingRow.closed_at ?? undefined,
          parentSessionId: existingRow.parent_session_id ?? undefined,
          lastActivityAt: existingRow.last_activity_at ?? undefined,
          taskId: existingRow.task_id ?? undefined,
          goalId: existingRow.goal_id ?? undefined,
          cwd: existingRow.cwd ?? undefined,
          gitBranch: existingRow.git_branch ?? undefined,
          projectPath: existingRow.project_path ?? projectPath,
        };

        if (metadata.model && metadata.model !== existing.model) {
          existing.model = metadata.model;
          updated = true;
        }

        if (channelId && channelId !== existing.channelId) {
          existing.channelId = channelId;
          updated = true;
        }

        // 更新 lastActivityAt（文件 mtime 可能比 DB 记录更新）
        if (!existing.lastActivityAt || fileMtimeMs > existing.lastActivityAt) {
          existing.lastActivityAt = fileMtimeMs;
          updated = true;
        }

        // 修正错误的 createdAt（导入时用了 Date.now() 的历史数据）
        if (createdAt < existing.createdAt) {
          existing.createdAt = createdAt;
          updated = true;
        }

        // 补充缺失的 context
        if (!existing.taskId && (channelId || existing.channelId)) {
          const ctx = resolveSessionContext(this.db, channelId || existing.channelId);
          if (ctx.taskId) {
            existing.taskId = ctx.taskId;
            existing.goalId = ctx.goalId ?? undefined;
            updated = true;
          }
          if (!existing.cwd && ctx.cwd) {
            existing.cwd = metadata.cwd ?? ctx.cwd ?? undefined;
            updated = true;
          }
          if (!existing.gitBranch && ctx.gitBranch) {
            existing.gitBranch = ctx.gitBranch ?? undefined;
            updated = true;
          }
        }

        // 补充缺失的 project_path
        if (!existingRow.project_path && projectPath) {
          existing.projectPath = projectPath;
          updated = true;
        }

        // 补充缺失的 title（executor 回调先创建记录时不带 title）
        if (!existingRow.title) {
          void this.generateAndSaveTitle(claudeSessionId, jsonlPath);
        }

        if (updated) {
          this.claudeSessionRepo.save(existing);
          return 'updated';
        }

        return 'skipped';
      }
    } catch (e: any) {
      logger.warn(`Failed to process ${jsonlPath}: ${e.message}`);
      return 'skipped';
    }
  }

  // ==================== Title 生成 ====================

  /**
   * 从 JSONL 文件提取第一条用户消息文本
   *
   * 读取前 32KB，找第一个 type='user' 且非 tool_result 的事件。
   */
  extractFirstUserMessage(jsonlPath: string): string | null {
    let fd: number | null = null;
    try {
      fd = openSync(jsonlPath, 'r');
      const buffer = Buffer.alloc(FIRST_MSG_BUFFER_SIZE);
      const bytesRead = readSync(fd, buffer, 0, FIRST_MSG_BUFFER_SIZE, 0);
      if (bytesRead === 0) return null;

      const content = buffer.toString('utf8', 0, bytesRead);
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);

          // 跳过非 user 事件
          if (event.type !== 'user') continue;

          // 排除 tool_result（内部消息）
          if (event.parent_tool_use_id || event.userType === 'internal') continue;

          // 提取文本内容
          const msgContent = event.message?.content;
          if (!msgContent) continue;

          let text: string | null = null;

          if (typeof msgContent === 'string') {
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            // 找第一个 text block
            for (const block of msgContent) {
              if (block.type === 'text' && block.text) {
                text = block.text;
                break;
              }
            }
          }

          if (text && text.trim()) {
            const trimmed = text.trim();
            // 跳过系统注入的消息（local-command-caveat 等）
            if (trimmed.startsWith('<local-command-caveat>') || trimmed.startsWith('<system-reminder>')) {
              continue;
            }
            return trimmed.slice(0, FIRST_MSG_MAX_CHARS);
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 用 LLM 生成 session title
   *
   * @returns 生成的 title，失败时用消息前 30 字符作 fallback
   */
  async generateSessionTitle(jsonlPath: string): Promise<string | null> {
    const firstMessage = this.extractFirstUserMessage(jsonlPath);
    if (!firstMessage) return null;

    // 尝试用 PromptConfigService 渲染 prompt
    let prompt: string;
    if (this.promptService) {
      const rendered = this.promptService.tryRender('session.title_generate', {
        FIRST_MESSAGE: firstMessage,
      });
      prompt = rendered ?? `根据以下用户消息生成一个简短的中文标题（≤30字），只输出标题：\n${firstMessage}`;
    } else {
      prompt = `根据以下用户消息生成一个简短的中文标题（≤30字），只输出标题：\n${firstMessage}`;
    }

    const result = await chatCompletion(prompt);
    if (result) {
      return result.slice(0, TITLE_MAX_CHARS);
    }

    // fallback: 截取消息前 30 字符
    return firstMessage.slice(0, TITLE_MAX_CHARS);
  }

  /** 生成 title 并保存到数据库 */
  private async generateAndSaveTitle(claudeSessionId: string, jsonlPath: string): Promise<void> {
    try {
      const title = await this.generateSessionTitle(jsonlPath);
      if (!title) return;

      this.db.prepare('UPDATE claude_sessions SET title = ? WHERE claude_session_id = ?').run(title, claudeSessionId);
      logger.debug(`Session title generated: "${title}" (${claudeSessionId.slice(0, 8)}...)`);
    } catch (e: any) {
      logger.warn(`Failed to generate title for ${claudeSessionId}: ${e.message}`);
    }
  }

  /** 批量补充缺失的 title */
  async backfillTitles(): Promise<void> {
    if (!this.promptService) {
      logger.debug('PromptService not available, skipping title backfill');
      return;
    }

    try {
      const rows = this.db.prepare(
        'SELECT claude_session_id FROM claude_sessions WHERE title IS NULL',
      ).all() as Array<{ claude_session_id: string }>;

      if (rows.length === 0) return;

      logger.info(`Backfilling titles for ${rows.length} sessions...`);
      let filled = 0;

      for (const row of rows) {
        // 在所有项目目录中查找对应的 JSONL 文件
        const jsonlPath = this.findJsonlFile(row.claude_session_id);
        if (!jsonlPath) continue;

        const title = await this.generateSessionTitle(jsonlPath);
        if (title) {
          this.db.prepare('UPDATE claude_sessions SET title = ? WHERE claude_session_id = ?').run(title, row.claude_session_id);
          filled++;
        }

        // 间隔 200ms 避免 rate limit
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (filled > 0) {
        logger.info(`Title backfill completed: ${filled}/${rows.length} sessions`);
      }
    } catch (e: any) {
      logger.warn(`Title backfill failed: ${e.message}`);
    }
  }

  /** 在项目目录中查找指定 session ID 的 JSONL 文件 */
  private findJsonlFile(claudeSessionId: string): string | null {
    const projectDirs = this.listProjectDirs();
    for (const dir of projectDirs) {
      const filePath = join(dir, `${claudeSessionId}.jsonl`);
      try {
        if (statSync(filePath).isFile()) {
          return filePath;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  // ==================== Usage 扫描 ====================

  /**
   * 检测到 JSONL 文件有新增内容时，对整个文件做全量扫描并覆盖写 DB
   *
   * 只处理文件大小超过上次记录 offset 的 session（有变化才扫描），
   * 但扫描时从头读取整个文件以避免累加漂移。
   * fire-and-forget 调用，不阻塞同步循环。
   */
  private async processUsageDelta(jsonlPath: string): Promise<void> {
    try {
      // 从文件名提取 sessionId，跳过 agent-* 文件
      const fileName = basename(jsonlPath, '.jsonl');
      if (fileName.startsWith('agent-')) return;

      const claudeSessionId = fileName;

      // 查 DB 获取当前 offset（仅用于判断文件是否有新增内容）
      const row = this.db.prepare(
        'SELECT usage_file_offset FROM claude_sessions WHERE claude_session_id = ?',
      ).get(claudeSessionId) as { usage_file_offset: number } | undefined;

      if (!row) return; // session 尚未入库

      // 检查文件大小
      let fileSize: number;
      try {
        fileSize = statSync(jsonlPath).size;
      } catch {
        return;
      }

      if (fileSize <= row.usage_file_offset) return; // 无新增内容，跳过

      // 有新内容 → 全量扫描主文件 + 聚合子 agent 文件后覆盖写
      const totals = await this.fullScan(jsonlPath);

      // 聚合子 agent 用量（新格式：<SESSION_ID>/subagents/ 目录）
      const projectDir = dirname(jsonlPath);
      const subagentsDir = join(projectDir, claudeSessionId, 'subagents');
      const agentTotals = await this.scanSubagentsDir(subagentsDir);
      mergeTotals(totals, agentTotals);

      // 聚合子 agent 用量（旧格式：agent-*.jsonl 在项目根目录，通过 sessionId 字段关联）
      const oldAgentFiles = findOldFormatAgentFiles(projectDir, claudeSessionId);
      for (const agentFile of oldAgentFiles) {
        const t = await this.fullScan(agentFile);
        mergeTotals(totals, t);
      }

      this.usageOverwriteStmt.run(
        totals.tokensIn,
        totals.tokensOut,
        totals.cacheReadIn,
        totals.cacheWriteIn,
        totals.costUsd,
        totals.turnCount,
        fileSize,
        Object.keys(totals.byModel).length > 0 ? JSON.stringify(totals.byModel) : null,
        claudeSessionId,
      );
    } catch (e: any) {
      logger.debug(`[SessionSync] processUsageDelta failed: ${e.message}`);
    }
  }

  /**
   * 扫描 subagents 目录下所有 agent-*.jsonl 文件，返回聚合用量
   * 目录不存在时静默返回空统计
   */
  private async scanSubagentsDir(subagentsDir: string): Promise<UsageTotals> {
    const totals: UsageTotals = {
      tokensIn: 0, tokensOut: 0,
      cacheReadIn: 0, cacheWriteIn: 0,
      costUsd: 0, turnCount: 0,
      byModel: {},
    };

    try {
      const entries = readdirSync(subagentsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl') || !entry.startsWith('agent-')) continue;
        try {
          const agentTotals = await this.fullScan(join(subagentsDir, entry));
          mergeTotals(totals, agentTotals);
        } catch { /* 单个 agent 文件失败不影响整体 */ }
      }
    } catch { /* subagents 目录不存在，正常情况 */ }

    return totals;
  }

  /**
   * 全量读取一个 JSONL 文件，返回完整 token/cost 汇总
   *
   * 使用 messageId+requestId 去重，支持 byModel 分项统计。
   */
  private async fullScan(filePath: string): Promise<UsageTotals> {
    const totals: UsageTotals = {
      tokensIn: 0, tokensOut: 0,
      cacheReadIn: 0, cacheWriteIn: 0,
      costUsd: 0, turnCount: 0,
      byModel: {},
    };

    const seen = new Set<string>(); // messageId:requestId 去重

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        if (event.type !== 'assistant') continue;

        const usage = event.message?.usage;
        if (!usage) continue;

        // 去重：messageId + requestId
        const msgId = event.message?.id;
        const reqId = event.requestId;
        if (msgId && reqId) {
          const hash = `${msgId}:${reqId}`;
          if (seen.has(hash)) continue;
          seen.add(hash);
        }

        const tokensIn = usage.input_tokens ?? 0;
        const tokensOut = usage.output_tokens ?? 0;
        const cacheReadIn = usage.cache_read_input_tokens ?? 0;
        const cacheWriteIn = usage.cache_creation_input_tokens ?? 0;

        totals.tokensIn += tokensIn;
        totals.tokensOut += tokensOut;
        totals.cacheReadIn += cacheReadIn;
        totals.cacheWriteIn += cacheWriteIn;
        totals.turnCount++;

        // 费用：优先用预计算值
        let eventCost = 0;
        if (event.costUSD != null) {
          eventCost = event.costUSD;
        } else if (this.pricingService) {
          const model = event.message?.model;
          if (model) {
            eventCost = this.pricingService.calculateCost(usage, model);
          }
        }
        totals.costUsd += eventCost;

        // 按模型分类
        const model: string = event.message?.model ?? 'unknown';
        if (!totals.byModel[model]) {
          totals.byModel[model] = {
            tokensIn: 0, tokensOut: 0,
            cacheReadIn: 0, cacheWriteIn: 0,
            costUsd: 0, turnCount: 0,
          };
        }
        totals.byModel[model].tokensIn += tokensIn;
        totals.byModel[model].tokensOut += tokensOut;
        totals.byModel[model].cacheReadIn += cacheReadIn;
        totals.byModel[model].cacheWriteIn += cacheWriteIn;
        totals.byModel[model].costUsd += eventCost;
        totals.byModel[model].turnCount++;
      } catch {
        continue;
      }
    }

    return totals;
  }

  // ==================== 文件系统工具 ====================

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

  // ==================== 工具函数 ====================

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
}

/**
 * 在项目目录根层找旧格式 agent 文件（agent-*.jsonl），
 * 通过读取首行的 sessionId 字段与给定 sessionId 匹配
 */
function findOldFormatAgentFiles(projectDir: string, sessionId: string): string[] {
  const result: string[] = [];
  try {
    for (const entry of readdirSync(projectDir)) {
      if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
      const filePath = join(projectDir, entry);
      try {
        const firstLine = readFirstJsonLine(filePath);
        if (firstLine?.sessionId === sessionId) result.push(filePath);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return result;
}

/** 读取文件首行并解析为 JSON（读取前 512 字节足够） */
function readFirstJsonLine(filePath: string): Record<string, unknown> | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = readSync(fd, buf, 0, 512, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const newline = text.indexOf('\n');
    const line = newline === -1 ? text : text.slice(0, newline);
    return JSON.parse(line);
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** 将 src 的用量累加到 dst 中（in-place） */
function mergeTotals(dst: UsageTotals, src: UsageTotals): void {
  dst.tokensIn += src.tokensIn;
  dst.tokensOut += src.tokensOut;
  dst.cacheReadIn += src.cacheReadIn;
  dst.cacheWriteIn += src.cacheWriteIn;
  dst.costUsd += src.costUsd;
  dst.turnCount += src.turnCount;
  for (const [model, stats] of Object.entries(src.byModel)) {
    if (!dst.byModel[model]) {
      dst.byModel[model] = { tokensIn: 0, tokensOut: 0, cacheReadIn: 0, cacheWriteIn: 0, costUsd: 0, turnCount: 0 };
    }
    dst.byModel[model].tokensIn += stats.tokensIn;
    dst.byModel[model].tokensOut += stats.tokensOut;
    dst.byModel[model].cacheReadIn += stats.cacheReadIn;
    dst.byModel[model].cacheWriteIn += stats.cacheWriteIn;
    dst.byModel[model].costUsd += stats.costUsd;
    dst.byModel[model].turnCount += stats.turnCount;
  }
}
