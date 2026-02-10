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
import { StreamEvent, AskUserQuestionInput, ExitPlanModeInput, ClaudeExecutionError, ClaudeErrorType, Session, FileChange } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { checkAuth } from './auth.js';
import { escapeHtml, buildDiffMessage } from './message-utils.js';
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
   * 公开方法：通过 groupId/topicId 发送消息，走完整流式进度路径
   * 适用于 qdev 等无 ctx 的场景
   */
  async sendChatByIds(
    groupId: number,
    topicId: number,
    text: string,
  ): Promise<void> {
    const session = this.stateManager.getOrCreateSession(groupId, topicId, {
      name: `topic-${topicId}`,
      cwd: this.stateManager.getGroupDefaultCwd(groupId),
    });
    return this.sendChatInternal(groupId, session, text);
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
    return this.sendChatInternal(ctx.chat!.id, session, text, mode, ctx);
  }

  private async sendChatInternal(
    chatId: number,
    session: Session,
    text: string,
    mode?: 'plan',
    ctx?: Context,
  ): Promise<void> {
    const MAX_INTERACTIVE_ROUNDS = 5;
    for (let round = 0; round < MAX_INTERACTIVE_ROUNDS; round++) {

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
    let lastAssistantUsage: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
    let sendChain = Promise.resolve();  // 文本发送串行链，防止并发导致顺序错乱

    // 交互式工具拦截：CLI 会自动拒绝 AskUserQuestion/ExitPlanMode，
    // 我们在流中检测到后记录问题数据，抑制后续误导性文本，chat() 结束后显示键盘
    // 用对象包装以绕过 TypeScript CFA（callback 内赋值不被追踪）
    const interactiveState: { pending: { toolName: string; toolUseId: string; input: any } | null } = { pending: null };

    // 收集文件变更
    const fileChanges: FileChange[] = [];

    const mq = this.mq;
    const replyMarkup = stopKeyboard.reply_markup;

    // 追踪所有曾经创建的进度消息 ID，用于最终清理
    const allProgressMsgIds = new Set<number>([progressMsgId]);
    let recreatingProgress = false;

    // 重建进度消息到底部，确保进度始终可见
    const recreateProgress = async () => {
      // 防止并发 recreate 导致 progressMsgId 竞态
      if (recreatingProgress) return;
      recreatingProgress = true;
      try {
        mq.delete(chatId, progressMsgId);
        progressMsgId = await mq.send(chatId, session.topicId, lastProgressText, { replyMarkup });
        allProgressMsgIds.add(progressMsgId);
      } finally {
        recreatingProgress = false;
      }
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
        lastAssistantUsage = null;
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

      // 收集文件变更（来自 user event 的 tool_use_result）并实时发送 diff
      // Write 工具返回 type:"create"，Edit 工具不返回 type 字段但有 structuredPatch
      if (event.type === 'user' && event.tool_use_result) {
        const tur = event.tool_use_result;
        if (tur.filePath) {
          let change: FileChange | null = null;
          if (tur.type === 'create') {
            change = { filePath: tur.filePath, type: 'create', patches: tur.structuredPatch, content: tur.content };
          } else if (tur.structuredPatch?.length) {
            change = { filePath: tur.filePath, type: 'update', patches: tur.structuredPatch };
          }
          if (change) {
            fileChanges.push(change);
            // 实时发送 diff 消息
            const { text: diffText, entities } = buildDiffMessage(change);
            mq.trackAsync(async () => {
              await mq.send(chatId, session.topicId, diffText, { entities, silent: true });
              await recreateProgress();
            }).catch(e => logger.debug('Send diff failed:', e));
          }
        }
      }

      if (event.type === 'assistant') {
        // 追踪最后一次 assistant 事件的 usage（反映当前 context 快照）
        if ((event.message as any)?.usage) {
          const u = (event.message as any).usage;
          lastAssistantUsage = {
            input_tokens: u.input_tokens || 0,
            cache_read_input_tokens: u.cache_read_input_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens,
          };
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

            // 串行链：保证多段文本按序发送 + 进度重建不并发
            sendChain = sendChain.then(async () => {
              await mq.sendLong(chatId, session.topicId, textContent);
              await recreateProgress();
            }).catch((e) => {
              sentTextCount--;  // 回退计数，确保最终 result 能补发
              logger.debug('Send text failed:', e);
            });
            mq.trackAsync(() => sendChain);  // drain 仍能感知
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

        // 删除所有进度消息（包括 recreateProgress 产生的残留）
        for (const msgId of allProgressMsgIds) {
          mq.delete(chatId, msgId);
        }

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

        // 无 ctx 时无法显示 Inline Keyboard，跳过交互
        if (!ctx) {
          await mq.drain();
          break;
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

      // 删除所有进度消息（包括 recreateProgress 产生的残留）
      for (const msgId of allProgressMsgIds) {
        mq.delete(chatId, msgId);
      }

      // 如果流式过程中没有发送过文本，或最终 result 与最后发送的文本不同，补发 result
      if (sentTextCount === 0 || (response.result.trim() && response.result.trim() !== lastSentText)) {
        await mq.sendLong(chatId, session.topicId, response.result);
      }

      // 发送完成标记（HTML 格式，带颜色百分比）
      const parts: string[] = [];
      if (response.duration_ms) parts.push(`${(response.duration_ms / 1000).toFixed(1)}s`);
      if (response.usage) {
        const { input_tokens, output_tokens } = response.usage;
        const thisTotal = input_tokens + output_tokens;
        parts.push(`${Math.round(thisTotal / 1000)}K`);
      }
      // Context window 百分比：带颜色
      const contextWindowSize = response.contextWindow || 200000;
      const snapshotUsage = lastAssistantUsage || (response.usage ? {
        input_tokens: response.usage.input_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
      } : null);
      let pctHtml = '';
      if (snapshotUsage) {
        const totalInput = snapshotUsage.input_tokens
          + (snapshotUsage.cache_read_input_tokens || 0)
          + (snapshotUsage.cache_creation_input_tokens || 0);
        const usedPct = Math.round((totalInput / contextWindowSize) * 100);
        const color = usedPct >= 80 ? '🔴' : usedPct >= 70 ? '🟡' : '🟢';
        pctHtml = `${color}${usedPct}%`;
      }
      if (pctHtml) parts.push(pctHtml);
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
        const fileInfo = fileChanges.length > 0 ? `, ${fileChanges.length} 文件变更` : '';
        await mq.send(chatId, session.topicId, `✅ 完成${summary}${fileInfo}`, { silent: false });
      }

    } catch (error: any) {
      // 等待未完成的 recreateProgress 等异步操作，确保 allProgressMsgIds 完整
      await mq.drain(3000).catch(() => {});

      // 清理 recreateProgress 产生的残留进度消息（保留当前 progressMsgId 用于显示错误）
      for (const msgId of allProgressMsgIds) {
        if (msgId !== progressMsgId) mq.delete(chatId, msgId);
      }

      // ABORTED: 用户主动停止，不显示错误
      if (error instanceof ClaudeExecutionError && error.errorType === ClaudeErrorType.ABORTED) {
        logger.info(`[${session.name}] Task aborted by user`);
        mq.edit(chatId, progressMsgId, `⏹ 已停止`);
        return;
      }

      // 非 ABORTED 错误：等待已提交的发送操作完成，防止与 error 消息竞态
      await sendChain.catch(() => {});
      await mq.drain(5000);

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
  ): Promise<void> {
    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) throw new Error('会话不存在');

    // 复用 sendChatInternal：完整的流式进度、消息队列、完成消息
    await this.sendChatInternal(groupId, session, message);
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
