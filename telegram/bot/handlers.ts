/**
 * Telegram Bot 消息处理器
 * 流式输出：工具调用 → 编辑进度消息；文本输出 → 立即发新消息
 * 文件变更收集：Write/Edit 结果中提取 structuredPatch，任务结束后发送可视化 HTML diff
 */

import { Context } from 'telegraf';
import { readFileSync } from 'fs';
import { Markup } from 'telegraf';
import { StateManager } from './state.js';
import { CallbackRegistry } from './callback-registry.js';
import { ClaudeClient } from '../claude/client.js';
import { MessageQueue } from './message-queue.js';
import { StreamEvent, StructuredPatch, AskUserQuestionInput, ExitPlanModeInput, ClaudeExecutionError, ClaudeErrorType, Session } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { checkAuth } from './auth.js';
import { escapeHtml } from './message-utils.js';
import type { CommandHandler } from './commands.js';

// 工具名称映射
const TOOL_NAMES: Record<string, string> = {
  Read: '读取文件',
  Write: '写入文件',
  Edit: '编辑文件',
  Glob: '搜索文件',
  Grep: '搜索内容',
  Bash: '执行命令',
  WebFetch: '获取网页',
  WebSearch: '搜索网络',
  Task: '启动子任务',
  NotebookEdit: '编辑笔记本',
};

// 收集的文件变更
interface FileChange {
  filePath: string;
  type: 'update' | 'create';
  patches?: StructuredPatch[];
  content?: string;   // 新建文件的完整内容
}

export class MessageHandler {
  private stateManager: StateManager;
  private claudeClient: ClaudeClient;
  private callbackRegistry: CallbackRegistry;
  private mq: MessageQueue;
  private commandHandler?: CommandHandler;

  constructor(stateManager: StateManager, claudeClient: ClaudeClient, callbackRegistry: CallbackRegistry, mq: MessageQueue) {
    this.stateManager = stateManager;
    this.claudeClient = claudeClient;
    this.callbackRegistry = callbackRegistry;
    this.mq = mq;
  }

  setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  // Plan mode 确认关键词
  private static PLAN_CONFIRM_WORDS = /^(ok|确认|执行|approve|go|yes|是|开始|实现|implement)$/i;

  async handleText(ctx: Context): Promise<void> {
    if (!ctx.chat) return;
    const groupId = ctx.chat.id;
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    const text = (ctx.message as any)?.text;

    if (!text) return;
    if (text.startsWith('/')) return;

    // 鉴权
    if (!checkAuth(ctx)) return;

    // 检查是否有 pending 的 topics 操作（create/rename/fork）
    // 注意：General Topic 中的消息也可能带有 message_thread_id，因此不能仅在 !topicId 时检查
    if (this.commandHandler) {
      const handled = await this.commandHandler.handleGeneralText(ctx, groupId, text);
      if (handled) return;
    }

    // General topic (无 thread_id) → 不进入聊天流程
    if (!topicId) return;

    // 检查是否有等待自定义文本输入的交互
    const pendingCustom = this.callbackRegistry.getPendingCustomText(groupId, topicId);
    if (pendingCustom) {
      this.callbackRegistry.resolve(pendingCustom.toolUseId, text);
      await ctx.reply(`✅ 已提交: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`, { message_thread_id: topicId });
      return;
    }

    // 尝试从消息上下文获取 Topic 名称
    const replyMsg = (ctx.message as any)?.reply_to_message;
    const topicCreated = replyMsg?.forum_topic_created;
    const topicName = topicCreated?.name || `topic-${topicId}`;

    // 获取或创建 session
    const session = this.stateManager.getOrCreateSession(groupId, topicId, {
      name: topicName,
      cwd: this.stateManager.getGroupDefaultCwd(groupId),
    });

    // 如果之前名称是默认值，且现在拿到了真实名称，同步更新
    if (topicCreated?.name && session.name !== topicCreated.name && session.name.startsWith('topic-')) {
      this.stateManager.setSessionName(groupId, topicId, topicCreated.name);
      session.name = topicCreated.name;
    }

    // Plan mode 确认流程
    if (session.planMode) {
      if (MessageHandler.PLAN_CONFIRM_WORDS.test(text.trim())) {
        await this.executePlanApproval(ctx, session);
        return;
      }
      return this.sendChat(ctx, session, text, 'plan');
    }

    return this.sendChat(ctx, session, text);
  }

  /**
   * /plan 命令调用：以 plan 模式发送消息
   */
  async handleTextWithMode(ctx: Context, mode: 'plan'): Promise<void> {
    if (!ctx.chat) return;
    const groupId = ctx.chat.id;
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    if (!topicId) return;

    const text = (ctx.message as any)?.text || '';
    const message = text.replace(/^\/plan\s*/, '').trim();
    if (!message) return;

    const session = this.stateManager.getOrCreateSession(groupId, topicId, {
      name: `topic-${topicId}`,
      cwd: this.stateManager.getGroupDefaultCwd(groupId),
    });
    return this.sendChat(ctx, session, message, mode);
  }

  /**
   * Plan 确认后执行：compact → 发送执行指令
   */
  private async executePlanApproval(ctx: Context, session: Session): Promise<void> {
    const chatId = ctx.chat!.id;

    // 清除 plan mode
    this.stateManager.setSessionPlanMode(session.groupId, session.topicId, false);

    if (!session.claudeSessionId) {
      await this.mq.send(chatId, session.topicId, '❌ 没有活跃的会话上下文，请重新发送 /plan 指令。');
      return;
    }

    // 1. Compact 上下文
    const compactMsgId = await this.mq.send(chatId, session.topicId, `🗜️ 正在压缩上下文后执行方案...`);
    try {
      const lockKey = StateManager.topicLockKey(session.groupId, session.topicId);
      await this.claudeClient.compact(session.claudeSessionId, session.cwd, lockKey);
      this.mq.edit(chatId, compactMsgId, `✅ 上下文已压缩，开始执行方案...`);
    } catch (error: any) {
      this.mq.edit(chatId, compactMsgId, `⚠️ 压缩失败 (${error.message})，直接执行方案...`);
    }

    // 2. 以正常模式发送执行指令
    return this.sendChat(ctx, session, '请按照上面的方案执行实现');
  }

  /**
   * 核心对话发送逻辑
   */
  private async sendChat(
    ctx: Context,
    session: Session,
    text: string,
    mode?: 'plan'
  ): Promise<void> {
    const MAX_INTERACTIVE_ROUNDS = 5;
    for (let round = 0; round < MAX_INTERACTIVE_ROUNDS; round++) {
    const chatId = ctx.chat!.id;

    logger.info(`[${session.name}] Message:`, text.substring(0, 100));

    // 记录用户消息
    this.stateManager.updateSessionMessage(session.groupId, session.topicId, text, 'user');

    const modeLabel = mode === 'plan' ? ' Plan' : '';
    // 停止按钮
    const lockKey = StateManager.topicLockKey(session.groupId, session.topicId);
    const stopKeyboard = Markup.inlineKeyboard([[
      Markup.button.callback('⏹ 停止', `stop:${lockKey.slice(0, 20)}`)
    ]]);
    // 发送初始进度消息（附带停止按钮）
    let progressMsgId = await this.mq.send(chatId, session.topicId, `⏳${modeLabel} 思考中...`, { replyMarkup: stopKeyboard.reply_markup });

    // 进度状态
    let lastProgressText = `⏳${modeLabel} 思考中...`;
    let toolUseCount = 0;
    let lastEditTime = Date.now();
    let sentTextCount = 0;
    let lastSentText = '';
    let compactPreTokens: number | null = null;

    // 交互式工具拦截：CLI 会自动拒绝 AskUserQuestion/ExitPlanMode，
    // 我们在流中检测到后记录问题数据，抑制后续误导性文本，chat() 结束后显示键盘
    // 用对象包装以绕过 TypeScript CFA（callback 内赋值不被追踪）
    const interactiveState: { pending: { toolName: string; toolUseId: string; input: any } | null } = { pending: null };

    // 收集文件变更
    const fileChanges: FileChange[] = [];

    const mq = this.mq;
    const replyMarkup = stopKeyboard.reply_markup;

    // 重建进度消息到底部，确保进度始终可见
    const recreateProgress = async () => {
      mq.delete(chatId, progressMsgId);
      progressMsgId = await mq.send(chatId, session.topicId, lastProgressText, { replyMarkup });
    };

    // 进度回调
    const onProgress = (event: StreamEvent) => {
      // 排队等锁通知
      const subtype = (event as any).subtype;
      if (event.type === 'system' && subtype === 'queued') {
        const pos = (event as any).queue_position || '?';
        const newText = `⏳ 排队中 (第 ${pos} 位)，前一个任务仍在执行...`;
        mq.edit(chatId, progressMsgId, newText, { replyMarkup });
        return;
      }
      if (event.type === 'system' && subtype === 'lock_acquired') {
        const newText = `⏳ 思考中...`;
        lastProgressText = newText;
        mq.edit(chatId, progressMsgId, newText, { replyMarkup });
        return;
      }
      // 重试/会话重置通知
      if (event.type === 'system' && subtype === 'session_reset') {
        const newText = `⚠️ 会话上下文过长，已自动重置...`;
        mq.edit(chatId, progressMsgId, newText, { replyMarkup });
        this.stateManager.clearSessionClaudeId(session.groupId, session.topicId);
        return;
      }
      if (event.type === 'system' && subtype === 'retrying') {
        const newText = `🔄 执行出错，正在重试...`;
        mq.edit(chatId, progressMsgId, newText, { replyMarkup });
        return;
      }
      if (event.type === 'system' && subtype === 'reset_state') {
        // 重置发送状态，防止重试时重复发送消息
        sentTextCount = 0;
        lastSentText = '';
        fileChanges.length = 0;
        toolUseCount = 0;
        compactPreTokens = null;
        interactiveState.pending = null;
        return;
      }

      // compact 进度
      if (event.status === 'compacting') {
        const newText = `🗜️ 正在压缩上下文...`;
        mq.edit(chatId, progressMsgId, newText, { replyMarkup });
        return;
      }
      if (event.compact_metadata) {
        compactPreTokens = event.compact_metadata.pre_tokens;
      }
      if (event.subtype === 'compact_boundary') {
        const newText = `⏳ 上下文已压缩，继续思考...`;
        mq.edit(chatId, progressMsgId, newText, { replyMarkup });
        return;
      }

      // 收集文件变更（来自 user event 的 tool_use_result）
      // Write 工具返回 type:"create"，Edit 工具不返回 type 字段但有 structuredPatch
      if (event.type === 'user' && event.tool_use_result) {
        const tur = event.tool_use_result;
        if (tur.filePath) {
          if (tur.type === 'create') {
            fileChanges.push({
              filePath: tur.filePath,
              type: 'create',
              patches: tur.structuredPatch,
              content: tur.content,
            });
          } else if (tur.structuredPatch?.length) {
            fileChanges.push({
              filePath: tur.filePath,
              type: 'update',
              patches: tur.structuredPatch,
            });
          }
        }
      }

      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use' && block.name) {
            // 检测被 CLI 自动拒绝的交互式工具
            if ((block.name === 'AskUserQuestion' || block.name === 'ExitPlanMode') && block.id) {
              interactiveState.pending = { toolName: block.name, toolUseId: block.id, input: block.input };
              logger.debug(`Detected interactive tool: ${block.name} [${block.id.slice(-8)}]`);
              continue; // 不计入 toolUseCount
            }

            toolUseCount++;
            const toolLabel = TOOL_NAMES[block.name] || block.name;

            let detail = '';
            if (block.input) {
              if (block.name === 'Read' && block.input.file_path) {
                detail = `: ${this.shortPath(block.input.file_path)}`;
              } else if (block.name === 'Bash' && block.input.command) {
                detail = `: ${block.input.command.slice(0, 40)}`;
              } else if (block.name === 'Grep' && block.input.pattern) {
                detail = `: ${block.input.pattern}`;
              } else if (block.name === 'Glob' && block.input.pattern) {
                detail = `: ${block.input.pattern}`;
              } else if ((block.name === 'Edit' || block.name === 'Write') && block.input.file_path) {
                detail = `: ${this.shortPath(block.input.file_path)}`;
              }
            }

            const newText = `🔧 [${toolUseCount}] ${toolLabel}${detail}`;

            const now = Date.now();
            if (newText !== lastProgressText && now - lastEditTime >= 1000) {
              lastProgressText = newText;
              lastEditTime = now;
              mq.edit(chatId, progressMsgId, newText, { replyMarkup });
            }
          } else if (block.type === 'text' && block.text) {
            // 抑制 pending interactive 后的文本（模型对 auto-denial 的误导回复）
            if (interactiveState.pending) continue;

            const textContent = block.text.trim();
            if (!textContent) continue;

            sentTextCount++;
            lastSentText = textContent;

            // 通过消息队列发送，sendLong 自动处理长消息
            // trackAsync 让 drain 能感知这个悬空 Promise
            mq.trackAsync(async () => {
              await mq.sendLong(chatId, session.topicId, textContent);
              await recreateProgress();
            }).catch((e) => {
              sentTextCount--;  // 回退计数，确保最终 result 能补发
              logger.debug('Send text failed:', e);
            });
          }
        }
      }
    };

    try {
      const effectiveModel = session.model ?? this.stateManager.getGroupDefaultModel(session.groupId);
      const response = await this.claudeClient.chat(text, {
        sessionId: session.claudeSessionId,
        cwd: session.cwd,
        lockKey,
        permissionMode: mode === 'plan' ? 'plan' : undefined,
        model: effectiveModel,
        groupId: session.groupId,
        topicId: session.topicId,
      }, onProgress);

      this.stateManager.setSessionClaudeId(session.groupId, session.topicId, response.sessionId);
      this.stateManager.updateSessionMessage(session.groupId, session.topicId, response.result, 'assistant');
      logger.info(`[${session.name}] Response length:`, response.result.length);

      // ==========================================
      // 交互式工具拦截：CLI 自动拒绝了 AskUserQuestion/ExitPlanMode，
      // 现在显示 Telegram 键盘收集用户输入，然后以新消息将答案发送回去
      // ==========================================
      if (interactiveState.pending) {
        const pi = interactiveState.pending;

        // 先排空消息队列
        await mq.drain(10000);

        // 删除进度消息
        mq.delete(chatId, progressMsgId);

        // 补发内容：ExitPlanMode 时优先发送 plan 文件完整内容
        let planSent = false;
        if (pi.toolName === 'ExitPlanMode') {
          const planFile = fileChanges.find(fc => fc.filePath.includes('.claude/plans/') && fc.filePath.endsWith('.md'));
          if (planFile) {
            try {
              const planContent = readFileSync(planFile.filePath, 'utf-8').trim();
              if (planContent) {
                await mq.sendLong(chatId, session.topicId, planContent);
                planSent = true;
              }
            } catch {}
          }
        }
        if (!planSent && (sentTextCount === 0 || (response.result.trim() && response.result.trim() !== lastSentText))) {
          await mq.sendLong(chatId, session.topicId, response.result);
        }

        // 显示 Inline Keyboard 等待用户输入
        const answer = await this.showInteractivePrompt(
          ctx, chatId, session.topicId, pi.toolUseId, pi.toolName, pi.input
        );

        // 构造后续消息，把用户的回答作为新一轮发回 Claude
        let followUpText: string;
        if (pi.toolName === 'AskUserQuestion') {
          followUpText = `关于上面的问题，我的回答是: ${answer}`;
        } else {
          // ExitPlanMode
          if (answer === 'compact_execute') {
            // 压缩上下文后再执行
            const updatedSession = this.stateManager.getSession(session.groupId, session.topicId)!;
            const compactMsgId = await mq.send(chatId, session.topicId, `🗜️ 正在压缩上下文...`);
            try {
              const compactLockKey = response.sessionId || updatedSession.id;
              await this.claudeClient.compact(response.sessionId, updatedSession.cwd, compactLockKey);
              mq.edit(chatId, compactMsgId, `✅ 上下文已压缩，开始执行方案...`);
            } catch (error: any) {
              mq.edit(chatId, compactMsgId, `⚠️ 压缩失败 (${error.message})，直接执行方案...`);
            }
            followUpText = '请按照方案执行实现';
          } else if (answer === 'approve') {
            followUpText = '请按照方案执行实现';
          } else if (answer === 'reject') {
            followUpText = '我拒绝了这个方案，请不要执行';
          } else {
            followUpText = answer; // 用户自定义文本
          }
        }

        logger.debug(`Interactive follow-up: ${followUpText.slice(0, 80)}`);

        // 更新 session 引用（可能在 chat 中已更新）
        const latestSession = this.stateManager.getSession(session.groupId, session.topicId);
        text = followUpText;
        if (latestSession) session = latestSession;
        mode = undefined; // follow-up 不再是 plan mode
        continue;
      }

      // ==========================================
      // 正常流程（无交互式工具）
      // ==========================================

      // 等消息队列排空
      await mq.drain();

      // 删除进度消息
      mq.delete(chatId, progressMsgId);

      // 如果流式过程中没有发送过文本，或最终 result 与最后发送的文本不同，补发 result
      if (sentTextCount === 0 || (response.result.trim() && response.result.trim() !== lastSentText)) {
        await mq.sendLong(chatId, session.topicId, response.result);
      }

      // 有文件变更时，生成可视化 HTML diff 附件发送
      if (fileChanges.length > 0) {
        const htmlContent = this.buildHtmlDiffReport(fileChanges);
        await mq.sendDocument(chatId, session.topicId, htmlContent, 'changes.html',
          `📝 ${fileChanges.length} 个文件变更`);
      }

      // 发送完成标记
      const parts: string[] = [];
      if (toolUseCount > 0) parts.push(`${toolUseCount} 次工具调用`);
      if (fileChanges.length > 0) parts.push(`${fileChanges.length} 个文件变更`);
      if (compactPreTokens) parts.push(`压缩: ${Math.round(compactPreTokens / 1000)}K tokens`);
      if (response.duration_ms) parts.push(`${(response.duration_ms / 1000).toFixed(1)}s`);
      if (response.usage) {
        const { input_tokens, output_tokens, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 } = response.usage;
        const totalInput = input_tokens + cache_read_input_tokens + cache_creation_input_tokens;
        const total = totalInput + output_tokens;
        const CONTEXT_WINDOW = 200000;
        const usedPct = Math.round((totalInput / CONTEXT_WINDOW) * 100);
        parts.push(`${Math.round(total / 1000)}K tokens (${usedPct}%)`);
      }
      const summary = parts.length > 0 ? ` (${parts.join(', ')})` : '';

      if (mode === 'plan') {
        // Plan mode: 标记等待确认
        this.stateManager.setSessionPlanMode(session.groupId, session.topicId, true);
        await mq.send(chatId, session.topicId,
          `📋 方案已生成${summary}\n\n` +
          `回复 "ok" 或 "确认" 将自动压缩上下文并执行实现。\n` +
          `回复其他内容继续讨论方案。`,
          { silent: false }
        );
      } else {
        await mq.send(chatId, session.topicId, `✅ 完成${summary}`, { silent: false });
      }

    } catch (error: any) {
      // ABORTED: 用户主动停止，不显示错误
      if (error instanceof ClaudeExecutionError && error.errorType === ClaudeErrorType.ABORTED) {
        logger.info(`[${session.name}] Task aborted by user`);
        mq.edit(chatId, progressMsgId, `⏹ 已停止`);
        return;
      }

      logger.error(`[${session.name}] error:`, error.message);

      let hint = '提示: 使用 /clear 清空会话';
      if (error instanceof ClaudeExecutionError) {
        if (error.errorType === ClaudeErrorType.SESSION_RECOVERABLE) {
          // 重试也失败了，自动清除坏 session
          this.stateManager.clearSessionClaudeId(session.groupId, session.topicId);
          hint = '会话已自动重置，请重新发送消息';
        } else if (error.errorType === ClaudeErrorType.FATAL) {
          hint = '请检查 Bot 配置（Claude CLI 是否可用）';
        }
      }

      mq.edit(chatId, progressMsgId, `❌ 发生错误:\n${error.message}\n\n${hint}`);
    }

    break;
    } // end for loop
  }

  /**
   * 后台发送消息到指定 session，无进度更新，结果静默存储
   */
  async handleBackgroundChat(
    groupId: number,
    topicId: number,
    message: string
  ): Promise<{ result: string; sessionId: string }> {
    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) throw new Error('会话不存在');

    this.stateManager.updateSessionMessage(groupId, topicId, message, 'user');

    const lockKey = StateManager.topicLockKey(groupId, topicId);
    try {
      const effectiveModel = session.model ?? this.stateManager.getGroupDefaultModel(groupId);
      const response = await this.claudeClient.chat(message, {
        sessionId: session.claudeSessionId,
        cwd: session.cwd,
        lockKey,
        model: effectiveModel,
        groupId,
        topicId,
      });

      this.stateManager.setSessionClaudeId(groupId, topicId, response.sessionId);
      this.stateManager.updateSessionMessage(groupId, topicId, response.result, 'assistant');

      return response;
    } catch (error: any) {
      if (error instanceof ClaudeExecutionError && error.errorType === ClaudeErrorType.SESSION_RECOVERABLE) {
        this.stateManager.clearSessionClaudeId(groupId, topicId);
      }
      throw error;
    }
  }

  /**
   * 从文件路径推断 highlight.js 语言标识
   */
  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
      kt: 'kotlin', swift: 'swift', cs: 'csharp', cpp: 'cpp', c: 'c',
      h: 'c', hpp: 'cpp', vue: 'xml', svelte: 'xml',
      html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
      css: 'css', scss: 'scss', less: 'less',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
      md: 'markdown', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
      dockerfile: 'dockerfile', makefile: 'makefile',
      graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
    };
    return map[ext] || 'plaintext';
  }

  /**
   * 将收集到的文件变更生成可视化 HTML diff 报告（GitHub 风格 + 语法高亮）
   */
  private buildHtmlDiffReport(changes: FileChange[]): string {
    const esc = escapeHtml;

    // 统计增删行数
    let totalAdd = 0, totalDel = 0;
    for (const c of changes) {
      if (c.type === 'create' && c.content) {
        totalAdd += c.content.split('\n').length;
      } else if (c.patches) {
        for (const p of c.patches) {
          for (const l of p.lines) {
            if (l[0] === '+') totalAdd++;
            else if (l[0] === '-') totalDel++;
          }
        }
      }
    }

    // 生成文件索引列表
    const fileIndex = changes.map((c, i) => {
      const badge = c.type === 'create'
        ? '<span class="badge new">new file</span>'
        : '<span class="badge mod">modified</span>';
      let stats = '';
      if (c.type === 'create' && c.content) {
        const n = c.content.split('\n').length;
        stats = `<span class="stat-add">+${n}</span>`;
      } else if (c.patches) {
        let a = 0, d = 0;
        for (const p of c.patches) for (const l of p.lines) { if (l[0] === '+') a++; else if (l[0] === '-') d++; }
        stats = `<span class="stat-add">+${a}</span> <span class="stat-del">-${d}</span>`;
      }
      const shortPath = c.filePath.replace(/^\/home\/[^/]+\//, '~/');
      return `<a href="#file-${i}" class="file-link"><span class="file-icon">📄</span> ${esc(shortPath)} ${badge} <span class="stats">${stats}</span></a>`;
    }).join('\n');

    // 生成每个文件的 diff 区块
    const fileSections = changes.map((change, i) => {
      const lang = this.detectLanguage(change.filePath);
      const badge = change.type === 'create'
        ? '<span class="badge new">new file</span>'
        : '<span class="badge mod">modified</span>';
      const shortPath = change.filePath.replace(/^\/home\/[^/]+\//, '~/');
      const header = `<div class="file-header" id="file-${i}"><span class="file-icon">📄</span> ${esc(shortPath)} ${badge}</div>`;

      let rows = '';

      if (change.type === 'create' && change.content) {
        const contentLines = change.content.split('\n');
        rows = contentLines.map((line, idx) =>
          `<tr class="line-add"><td class="ln ln-empty"></td><td class="ln ln-add">${idx + 1}</td><td class="sign">+</td><td class="code"><code class="language-${lang}">${esc(line) || ' '}</code></td></tr>`
        ).join('\n');
      } else if (change.type === 'update' && change.patches) {
        for (const patch of change.patches) {
          rows += `<tr class="hunk-header"><td class="ln" colspan="2"></td><td class="sign"></td><td class="code"><code>@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@</code></td></tr>\n`;
          let oldLine = patch.oldStart;
          let newLine = patch.newStart;
          for (const line of patch.lines) {
            const prefix = line[0];
            const content = line.slice(1);
            if (prefix === '+') {
              rows += `<tr class="line-add"><td class="ln ln-empty"></td><td class="ln ln-add">${newLine}</td><td class="sign sign-add">+</td><td class="code"><code class="language-${lang}">${esc(content) || ' '}</code></td></tr>\n`;
              newLine++;
            } else if (prefix === '-') {
              rows += `<tr class="line-del"><td class="ln ln-del">${oldLine}</td><td class="ln ln-empty"></td><td class="sign sign-del">-</td><td class="code"><code class="language-${lang}">${esc(content) || ' '}</code></td></tr>\n`;
              oldLine++;
            } else {
              rows += `<tr class="line-ctx"><td class="ln">${oldLine}</td><td class="ln">${newLine}</td><td class="sign"></td><td class="code"><code class="language-${lang}">${esc(content) || ' '}</code></td></tr>\n`;
              oldLine++;
              newLine++;
            }
          }
        }
      }

      return `<div class="file-block">${header}<table class="diff-table">${rows}</table></div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${changes.length} files changed</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css">
<style>
:root {
  --bg: #0d1117; --bg-subtle: #161b22; --border: #30363d;
  --fg: #e6edf3; --fg-muted: #8b949e;
  --add-bg: rgba(63,185,80,0.15); --add-bg-hl: rgba(63,185,80,0.3);
  --add-fg: #aff5b4; --add-ln: rgba(63,185,80,0.1);
  --del-bg: rgba(248,81,73,0.15); --del-bg-hl: rgba(248,81,73,0.3);
  --del-fg: #ffa198; --del-ln: rgba(248,81,73,0.1);
  --hunk-bg: rgba(56,139,253,0.1);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 14px; padding: 16px; max-width: 1280px; margin: 0 auto; }

/* summary */
.summary { background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin-bottom: 16px; }
.summary h1 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
.summary .meta { color: var(--fg-muted); font-size: 13px; margin-bottom: 12px; }
.stat-add { color: #3fb950; font-weight: 600; margin-right: 4px; }
.stat-del { color: #f85149; font-weight: 600; }
.file-link { display: flex; align-items: center; gap: 6px; color: #58a6ff; text-decoration: none; padding: 3px 0; font-size: 13px; font-family: 'SF Mono', 'Fira Code', Consolas, monospace; }
.file-link:hover { text-decoration: underline; }
.file-icon { font-size: 12px; }
.stats { margin-left: auto; font-size: 12px; }

/* badges */
.badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 12px; font-weight: 500; vertical-align: middle; margin-left: 6px; }
.badge.new { background: rgba(63,185,80,0.2); color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
.badge.mod { background: rgba(210,153,34,0.2); color: #d29922; border: 1px solid rgba(210,153,34,0.3); }

/* file blocks */
.file-block { margin-bottom: 16px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); }
.file-header { background: var(--bg-subtle); padding: 8px 16px; font-weight: 600; font-size: 13px; color: var(--fg); border-bottom: 1px solid var(--border); font-family: 'SF Mono', 'Fira Code', Consolas, monospace; display: flex; align-items: center; gap: 6px; }

/* diff table */
.diff-table { width: 100%; border-collapse: collapse; font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 12px; line-height: 20px; }
.diff-table td { vertical-align: top; }
.ln { width: 40px; min-width: 40px; text-align: right; padding: 0 8px; color: var(--fg-muted); user-select: none; font-size: 12px; border-right: 1px solid var(--border); }
.ln-empty { color: transparent; }
.sign { width: 16px; min-width: 16px; text-align: center; user-select: none; padding: 0 2px; color: var(--fg-muted); }
.sign-add { color: #3fb950; }
.sign-del { color: #f85149; }
.code { width: 100%; }
.code code { display: block; margin: 0; padding: 0 12px; white-space: pre-wrap; word-break: break-all; background: transparent !important; font-size: 12px; line-height: 20px; }

/* line backgrounds */
.line-add { background: var(--add-bg); }
.line-add .ln { background: var(--add-ln); }
.line-add .code code { color: var(--add-fg); }
.line-del { background: var(--del-bg); }
.line-del .ln { background: var(--del-ln); }
.line-del .code code { color: var(--del-fg); }
.line-ctx { background: var(--bg); }
.hunk-header { background: var(--hunk-bg); }
.hunk-header .code code { color: var(--fg-muted); font-style: italic; }

/* hljs syntax tokens — apply to all line types (ctx/add/del) */
.code code .hljs-keyword,
.code code .hljs-built_in,
.code code .hljs-type,
.code code .hljs-literal { color: #ff7b72; }
.code code .hljs-string,
.code code .hljs-regexp { color: #a5d6ff; }
.code code .hljs-number { color: #79c0ff; }
.code code .hljs-comment { color: #8b949e; font-style: italic; }
.code code .hljs-function .hljs-title,
.code code .hljs-title.function_ { color: #d2a8ff; }
.code code .hljs-attr,
.code code .hljs-attribute { color: #79c0ff; }
.code code .hljs-variable,
.code code .hljs-template-variable { color: #ffa657; }
.code code .hljs-meta { color: #79c0ff; }
.code code .hljs-tag { color: #7ee787; }
.code code .hljs-name { color: #7ee787; }
.code code .hljs-selector-class,
.code code .hljs-selector-id { color: #d2a8ff; }
.code code .hljs-params { color: var(--fg); }
.line-add .code code .hljs-comment,
.line-del .code code .hljs-comment { opacity: 0.7; }

/* expandable marker */
.expand-marker { text-align: center; padding: 4px; background: var(--bg-subtle); cursor: pointer; color: var(--fg-muted); font-size: 12px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }

/* mobile responsive */
@media (max-width: 768px) {
  body { padding: 8px; font-size: 13px; }
  .summary { padding: 12px; }
  .summary h1 { font-size: 14px; }
  .file-link { font-size: 12px; }
  .file-header { padding: 6px 8px; font-size: 12px; }
  .file-block { overflow-x: auto; }
  .diff-table { font-size: 11px; line-height: 18px; }
  .ln { width: 28px; min-width: 28px; padding: 0 4px; font-size: 11px; }
  .sign { width: 12px; min-width: 12px; }
  .code code { padding: 0 6px; font-size: 11px; line-height: 18px; }
}
</style>
</head>
<body>
<div class="summary">
<h1>${changes.length} files changed</h1>
<div class="meta"><span class="stat-add">+${totalAdd}</span> additions, <span class="stat-del">-${totalDel}</span> deletions</div>
${fileIndex}
</div>
${fileSections}
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
<script>
document.querySelectorAll('.code code[class*="language-"]').forEach(el => {
  hljs.highlightElement(el);
});
</script>
</body>
</html>`;
  }

  /**
   * 路由交互式工具到具体 UI
   */
  private async showInteractivePrompt(
    ctx: Context,
    chatId: number,
    topicId: number,
    toolUseId: string,
    toolName: string,
    input: any
  ): Promise<string> {
    if (toolName === 'AskUserQuestion') {
      return this.showAskUserQuestion(ctx, chatId, topicId, toolUseId, input as AskUserQuestionInput);
    } else if (toolName === 'ExitPlanMode') {
      return this.showExitPlanMode(ctx, chatId, topicId, toolUseId, input as ExitPlanModeInput);
    }
    throw new Error(`未知的交互式工具: ${toolName}`);
  }

  /**
   * 显示 AskUserQuestion 的 Inline Keyboard，等待用户选择后返回答案文本
   */
  private async showAskUserQuestion(
    ctx: Context,
    chatId: number,
    topicId: number,
    toolUseId: string,
    input: AskUserQuestionInput
  ): Promise<string> {
    const truncatedId = toolUseId.slice(-20);
    // 取第一个问题（AskUserQuestion 通常只有 1 个）
    const q = input.questions?.[0];
    if (!q) return '无问题';

    // 构建问题文本
    let questionText = `❓ <b>${escapeHtml(q.header || '请选择')}</b>\n\n${escapeHtml(q.question)}\n`;
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      questionText += `\n${i + 1}. <b>${escapeHtml(opt.label)}</b>`;
      if (opt.description) questionText += ` — ${escapeHtml(opt.description)}`;
    }

    // 构建 Inline Keyboard（每行一个按钮 + 其他）
    const buttons = q.options.map((opt, i) =>
      Markup.button.callback(
        `${i + 1}. ${opt.label}`.slice(0, 40),
        `input:${truncatedId}:${i}`
      )
    );
    buttons.push(
      Markup.button.callback('✏️ 其他', `input:${truncatedId}:other`)
    );
    const keyboard = Markup.inlineKeyboard(buttons.map(b => [b]));

    let msg;
    try {
      msg = await ctx.reply(questionText, { parse_mode: 'HTML', disable_notification: false, ...keyboard });
    } catch {
      msg = await ctx.reply(questionText, { disable_notification: false, ...keyboard });
    }

    // 注册到 CallbackRegistry 并等待用户响应
    const labels = q.options.map(o => o.label);
    const promise = this.callbackRegistry.register(toolUseId, chatId, topicId, msg.message_id, 'AskUserQuestion');
    this.callbackRegistry.setOptionMapping(toolUseId, labels);

    return promise;
  }

  /**
   * 显示 ExitPlanMode 的批准/拒绝 UI
   */
  private async showExitPlanMode(
    ctx: Context,
    chatId: number,
    topicId: number,
    toolUseId: string,
    input: ExitPlanModeInput
  ): Promise<string> {
    const truncatedId = toolUseId.slice(-20);

    let text = '📋 <b>方案已就绪，等待确认</b>\n';
    if (input.allowedPrompts?.length) {
      text += '\n执行此方案需要以下权限:\n';
      for (const p of input.allowedPrompts) {
        text += `• ${escapeHtml(p.tool)}: ${escapeHtml(p.prompt)}\n`;
      }
    }
    text += '\n请选择操作:';

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ 批准执行', `input:${truncatedId}:approve`)],
      [Markup.button.callback('🗜️ 压缩并执行', `input:${truncatedId}:compact_execute`)],
      [Markup.button.callback('❌ 拒绝', `input:${truncatedId}:reject`)],
      [Markup.button.callback('✏️ 修改方案', `input:${truncatedId}:other`)],
    ]);

    let msg;
    try {
      msg = await ctx.reply(text, { parse_mode: 'HTML', disable_notification: false, ...keyboard });
    } catch {
      msg = await ctx.reply(text, { disable_notification: false, ...keyboard });
    }

    const promise = this.callbackRegistry.register(toolUseId, chatId, topicId, msg.message_id, 'ExitPlanMode');

    return promise;
  }

  private shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : filePath;
  }

  private async sendFileAttachment(ctx: Context, content: string, filename: string, caption: string): Promise<void> {
    const chatId = ctx.chat!.id;
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    await this.mq.sendDocument(chatId, topicId, content, filename, caption);
  }

}
