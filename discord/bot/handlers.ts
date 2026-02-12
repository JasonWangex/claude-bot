/**
 * Discord Bot 消息处理器
 * 流式输出：工具调用 → 编辑进度消息；文本输出 → 发新消息
 * 文件变更收集：Write/Edit 结果中提取 structuredPatch，任务结束后发送 HTML diff
 */

import { readFileSync } from 'fs';
import {
  type Message,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js';
import { StateManager } from './state.js';
import { InteractionRegistry } from './interaction-registry.js';
import { ClaudeClient } from '../claude/client.js';
import { MessageQueue, EmbedColors } from './message-queue.js';
import { escapeMarkdown, buildChangesHtml } from './message-utils.js';
import {
  StreamEvent,
  AskUserQuestionInput,
  ExitPlanModeInput,
  ClaudeExecutionError,
  ClaudeErrorType,
  Session,
  FileChange,
  ImageAttachment,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { downloadAndProcessImage } from '../utils/image-processor.js';

// 工具名称映射
const TOOL_NAMES: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  Glob: 'Searching files',
  Grep: 'Searching content',
  Bash: 'Running command',
  WebFetch: 'Fetching web',
  WebSearch: 'Searching web',
  Task: 'Launching subtask',
  NotebookEdit: 'Editing notebook',
};

export class MessageHandler {
  private stateManager: StateManager;
  private claudeClient: ClaudeClient;
  private interactionRegistry: InteractionRegistry;
  private mq: MessageQueue;
  private errorReporter?: (guildId: string | undefined, threadId: string | undefined, source: string, error: any) => void;

  constructor(
    stateManager: StateManager,
    claudeClient: ClaudeClient,
    interactionRegistry: InteractionRegistry,
    mq: MessageQueue,
  ) {
    this.stateManager = stateManager;
    this.claudeClient = claudeClient;
    this.interactionRegistry = interactionRegistry;
    this.mq = mq;
  }

  setErrorReporter(reporter: (guildId: string | undefined, threadId: string | undefined, source: string, error: any) => void): void {
    this.errorReporter = reporter;
  }

  // Plan mode 确认关键词
  private static PLAN_CONFIRM_WORDS = /^(ok|确认|执行|approve|go|yes|是|开始|实现|implement)$/i;

  /**
   * 处理 Forum Post Thread 中的文字消息
   */
  async handleText(message: Message): Promise<void> {
    const guildId = message.guildId;
    const threadId = message.channelId;
    if (!guildId) return;

    let text = message.content;
    if (!text) return;

    // // 前缀 → Claude skill 命令
    if (text.startsWith('//')) {
      text = text.slice(1);
    } else if (text.startsWith('/')) {
      return; // slash command, ignore
    }

    const threadName = message.channel && 'name' in message.channel ? (message.channel as any).name : `thread-${threadId}`;

    const session = this.stateManager.getOrCreateSession(guildId, threadId, {
      name: threadName,
      cwd: this.stateManager.getGuildDefaultCwd(guildId),
    });

    // Plan mode 确认
    if (session.planMode) {
      if (MessageHandler.PLAN_CONFIRM_WORDS.test(text.trim())) {
        await this.executePlanApproval(guildId, threadId, session);
        return;
      }
      return this.sendChatInternal(guildId, session, text, 'plan');
    }

    return this.sendChatInternal(guildId, session, text);
  }

  /**
   * 处理图片消息
   */
  async handlePhoto(message: Message): Promise<void> {
    const guildId = message.guildId;
    const threadId = message.channelId;
    if (!guildId) return;

    const attachments = message.attachments.filter(a => a.contentType?.startsWith('image/'));
    if (attachments.size === 0) return;

    const threadName = message.channel && 'name' in message.channel ? (message.channel as any).name : `thread-${threadId}`;
    const session = this.stateManager.getOrCreateSession(guildId, threadId, {
      name: threadName,
      cwd: this.stateManager.getGuildDefaultCwd(guildId),
    });

    const processingMsgId = await this.mq.send(threadId, 'Processing image...', { silent: true });

    try {
      const firstAttachment = attachments.first()!;
      const image = await downloadAndProcessImage(firstAttachment.url);
      logger.info(`[${session.name}] Photo processed: ${image.mediaType}, ${Math.round(image.data.length * 3 / 4 / 1024)}KB`);

      this.mq.delete(threadId, processingMsgId);

      const caption = message.content?.trim() || 'Please look at this image';
      return this.sendChatInternal(guildId, session, caption, undefined, [image]);
    } catch (error: any) {
      logger.error(`[${session.name}] Photo processing error:`, error.message);
      this.mq.edit(threadId, processingMsgId, `Image processing failed: ${error.message}`);
    }
  }

  /**
   * 公开方法：通过 guildId/threadId 发送消息
   */
  async sendChatByIds(
    guildId: string,
    threadId: string,
    text: string,
  ): Promise<void> {
    const session = this.stateManager.getOrCreateSession(guildId, threadId, {
      name: `thread-${threadId}`,
      cwd: this.stateManager.getGuildDefaultCwd(guildId),
    });
    return this.sendChatInternal(guildId, session, text);
  }

  /**
   * Compact session context, show progress in thread
   */
  private async compactSession(threadId: string, sessionId: string, cwd: string, lockKey: string): Promise<void> {
    const compactMsgId = await this.mq.send(threadId, 'Compacting context...', { silent: true });
    try {
      await this.claudeClient.compact(sessionId, cwd, lockKey);
      this.mq.edit(threadId, compactMsgId, 'Context compacted. Executing plan...');
    } catch (error: any) {
      this.mq.edit(threadId, compactMsgId, `Compact failed (${error.message}), executing directly...`);
    }
  }

  /**
   * Plan 确认后执行
   */
  private async executePlanApproval(guildId: string, threadId: string, session: Session): Promise<void> {
    this.stateManager.setSessionPlanMode(guildId, threadId, false);

    if (!session.claudeSessionId) {
      await this.mq.send(threadId, 'No active context. Please send `/plan` again.', { silent: true });
      return;
    }

    const lockKey = StateManager.threadLockKey(guildId, threadId);
    await this.compactSession(threadId, session.claudeSessionId, session.cwd, lockKey);

    return this.sendChatInternal(guildId, session, '请按照上面的方案执行实现');
  }

  /**
   * 核心对话发送逻辑
   */
  private async sendChatInternal(
    guildId: string,
    session: Session,
    text: string,
    mode?: 'plan',
    images?: ImageAttachment[],
  ): Promise<void> {
    const threadId = session.threadId;
    const MAX_INTERACTIVE_ROUNDS = 5;

    for (let round = 0; round < MAX_INTERACTIVE_ROUNDS; round++) {

    this.mq.resetThreadState(threadId);
    logger.info(`[${session.name}] Message:`, text.substring(0, 100));
    this.stateManager.updateSessionMessage(guildId, threadId, text, 'user');

    const modeLabel = mode === 'plan' ? ' Plan' : '';
    const lockKey = StateManager.threadLockKey(guildId, threadId);

    // 停止按钮
    const stopButton = new ButtonBuilder()
      .setCustomId(`stop:${lockKey}`)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger);
    const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);

    let progressMsgId = await this.mq.send(threadId, `Thinking${modeLabel}...`, { components: [stopRow as any], priority: 'high', silent: true, embedColor: EmbedColors.GRAY });

    let lastProgressText = `Thinking${modeLabel}...`;
    let toolUseCount = 0;
    let lastEditTime = Date.now();
    const startTime = Date.now();
    let sentTextCount = 0;
    let compactPreTokens: number | null = null;
    let lastAssistantUsage: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
    let sendChain = Promise.resolve();

    // Text 占位消息
    let textPlaceholderMsgId: string | null = null;
    let textBuffer: string[] = [];
    let textFlushedContent = '';
    let lastTextFlushTime = 0;
    const TEXT_FLUSH_INTERVAL = 10000;

    // 交互式工具拦截
    const interactiveState: { pending: { toolName: string; toolUseId: string; input: any } | null } = { pending: null };

    // 文件变更收集
    const fileChanges: FileChange[] = [];

    const mq = this.mq;
    const allProgressMsgIds = new Set<string>([progressMsgId]);
    let recreatingProgress = false;

    const recreateProgress = async () => {
      if (recreatingProgress) return;
      recreatingProgress = true;
      try {
        mq.delete(threadId, progressMsgId);
        progressMsgId = await mq.send(threadId, lastProgressText, { components: [stopRow as any], silent: true, embedColor: EmbedColors.GRAY });
        allProgressMsgIds.add(progressMsgId);
      } finally {
        recreatingProgress = false;
      }
    };

    const flushTextBuffer = async () => {
      if (textBuffer.length === 0) return;
      const drained = textBuffer.splice(0);
      const newContent = drained.join('\n\n');

      try {
        // 尝试追加到现有占位消息（edit 仅支持 <= 2000 字符，超出会被截断）
        if (textPlaceholderMsgId) {
          const combined = textFlushedContent
            ? textFlushedContent + '\n\n' + newContent
            : newContent;
          if (combined.length <= 2000) {
            mq.edit(threadId, textPlaceholderMsgId, combined);
            textFlushedContent = combined;
            lastTextFlushTime = Date.now();
            return;
          }
          // 超限：不合并历史内容，新发一条消息
        }

        // 新发一条消息（sendLong 自动选格式：<2000 普通 / 2000-4096 embed / >4096 response.md）
        if (newContent.length <= 2000) {
          textPlaceholderMsgId = await mq.send(threadId, newContent, { priority: 'high', silent: true });
          textFlushedContent = newContent;
        } else {
          await mq.sendLong(threadId, newContent, { priority: 'high', silent: true });
          textPlaceholderMsgId = null;
          textFlushedContent = '';
        }
        await recreateProgress();
        lastTextFlushTime = Date.now();
      } catch (e) {
        textBuffer.unshift(...drained);
        throw e;
      }
    };

    const elapsed = () => `${Math.round((Date.now() - startTime) / 1000)}s`;

    // 进度回调
    const onProgress = (event: StreamEvent) => {
      const subtype = (event as any).subtype;
      if (event.type === 'system' && subtype === 'queued') {
        const pos = (event as any).queue_position || '?';
        // 显示 Interrupt & Send Now 按钮，让用户可以中断当前任务
        const interruptButton = new ButtonBuilder()
          .setCustomId(`interrupt:${lockKey.slice(0, 20)}`)
          .setLabel('Interrupt & Send Now')
          .setStyle(ButtonStyle.Primary);
        const cancelButton = new ButtonBuilder()
          .setCustomId(`stop:${lockKey.slice(0, 20)}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary);
        const queuedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(interruptButton, cancelButton);
        mq.edit(threadId, progressMsgId, `Queued (position ${pos})...`, { components: [queuedRow as any], embedColor: EmbedColors.GRAY });
        return;
      }
      if (event.type === 'system' && subtype === 'lock_acquired') {
        // 检查中断上下文
        const interruptCtx = this.claudeClient.consumeInterruptContext(lockKey);
        const prefix = interruptCtx
          ? `Interrupted after ${interruptCtx.lastProgressText}. Resuming`
          : 'Thinking';
        const newText = `${prefix}... (${elapsed()})`;
        lastProgressText = newText;
        mq.edit(threadId, progressMsgId, newText, { components: [stopRow as any], embedColor: EmbedColors.GRAY });
        return;
      }
      if (event.type === 'system' && subtype === 'session_reset') {
        mq.edit(threadId, progressMsgId, 'Context too long, auto-reset...', { components: [stopRow as any], embedColor: EmbedColors.YELLOW });
        this.stateManager.clearSessionClaudeId(guildId, threadId);
        return;
      }
      if (event.type === 'system' && subtype === 'retrying') {
        mq.edit(threadId, progressMsgId, 'Error, retrying...', { components: [stopRow as any], embedColor: EmbedColors.YELLOW });
        return;
      }
      if (event.type === 'system' && subtype === 'stall_warning') {
        const secs = (event as any).stallSeconds || '?';
        const newText = `${lastProgressText}\n> Stalled ${secs}s (${elapsed()})... may be deep-thinking\n> Use Stop to cancel`;
        mq.edit(threadId, progressMsgId, newText, { components: [stopRow as any], embedColor: EmbedColors.YELLOW });
        return;
      }
      if (event.type === 'system' && subtype === 'reset_state') {
        sentTextCount = 0;
        fileChanges.length = 0;
        toolUseCount = 0;
        compactPreTokens = null;
        lastAssistantUsage = null;
        interactiveState.pending = null;
        textBuffer.length = 0;
        textFlushedContent = '';
        textPlaceholderMsgId = null;
        lastTextFlushTime = 0;
        return;
      }

      // 压缩状态事件: {type:"system", subtype:"status", status:"compacting"|null}
      if (event.type === 'system' && subtype === 'status' && event.status === 'compacting') {
        mq.edit(threadId, progressMsgId, `Compacting context... (${elapsed()})`, { components: [stopRow as any], embedColor: EmbedColors.GRAY });
        return;
      }
      // compact_boundary 携带 compact_metadata
      if (event.compact_metadata) {
        compactPreTokens = event.compact_metadata.pre_tokens;
      }
      if (subtype === 'compact_boundary') {
        mq.edit(threadId, progressMsgId, `Context compacted, thinking... (${elapsed()})`, { components: [stopRow as any], embedColor: EmbedColors.GRAY });
        return;
      }

      // 收集文件变更
      if (event.type === 'user' && event.tool_use_result) {
        const tur = event.tool_use_result;
        if (tur.filePath) {
          let change: FileChange | null = null;
          if (tur.type === 'create') {
            change = { filePath: tur.filePath, type: 'create', patches: tur.structuredPatch, content: tur.content };
          } else if (tur.structuredPatch?.length) {
            change = { filePath: tur.filePath, type: 'update', patches: tur.structuredPatch };
          }
          if (change) fileChanges.push(change);
        }
      }

      if (event.type === 'assistant') {
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
            if ((block.name === 'AskUserQuestion' || block.name === 'ExitPlanMode') && block.id) {
              interactiveState.pending = { toolName: block.name, toolUseId: block.id, input: block.input };
              logger.debug(`Detected interactive tool: ${block.name} [${block.id.slice(-8)}]`);
              continue;
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

            const newText = `[${toolUseCount}] ${toolLabel}${detail} (${elapsed()})`;

            const now = Date.now();
            if (newText !== lastProgressText && now - lastEditTime >= 5000) {
              lastProgressText = newText;
              lastEditTime = now;
              mq.edit(threadId, progressMsgId, newText, { components: [stopRow as any], embedColor: EmbedColors.GRAY });
              // 回写进度到 executor，用于中断上下文保存
              this.claudeClient.updateProgressInfo(lockKey, newText, toolUseCount);
            }
          } else if (block.type === 'text' && block.text) {
            if (interactiveState.pending) continue;

            const textContent = block.text.trim();
            if (!textContent) continue;

            sentTextCount++;

            textBuffer.push(textContent);
            const now = Date.now();
            if (!textPlaceholderMsgId || now - lastTextFlushTime >= TEXT_FLUSH_INTERVAL) {
              sendChain = sendChain.then(() => flushTextBuffer()).catch(e => {
                logger.warn('Flush text failed:', e);
              });
              mq.trackAsync(() => sendChain);
            }
          }
        }
      }
    };

    try {
      const effectiveModel = session.model ?? this.stateManager.getGuildDefaultModel(guildId);
      const response = await this.claudeClient.chat(text, {
        sessionId: session.claudeSessionId,
        cwd: session.cwd,
        lockKey,
        permissionMode: mode === 'plan' ? 'plan' : undefined,
        model: effectiveModel,
        guildId,
        threadId,
        images,
      }, onProgress);
      images = undefined;

      this.stateManager.setSessionClaudeId(guildId, threadId, response.sessionId);
      this.stateManager.updateSessionMessage(guildId, threadId, response.result, 'assistant');
      logger.info(`[${session.name}] Response length:`, response.result.length);

      // 交互式工具拦截
      if (interactiveState.pending) {
        const pi = interactiveState.pending;

        await flushTextBuffer();
        await mq.drain(10000);

        for (const msgId of allProgressMsgIds) {
          mq.delete(threadId, msgId);
        }

        // 补发内容
        let planSent = false;
        if (pi.toolName === 'ExitPlanMode') {
          const planFile = fileChanges.find(fc => fc.filePath.includes('.claude/plans/') && fc.filePath.endsWith('.md'));
          if (planFile) {
            try {
              const planContent = readFileSync(planFile.filePath, 'utf-8').trim();
              if (planContent) {
                await mq.sendLong(threadId, planContent, { priority: 'high', silent: true });
                planSent = true;
              }
            } catch {}
          }
        }
        if (!planSent && sentTextCount === 0 && response.result.trim()) {
          await mq.sendLong(threadId, response.result, { priority: 'high', silent: true });
        }

        if (planSent) fileChanges.length = 0;

        // 显示 Discord Buttons 等待用户输入
        const answer = await this.showInteractivePrompt(
          guildId, threadId, pi.toolUseId, pi.toolName, pi.input
        );

        // 构造后续消息
        let followUpText: string;
        if (pi.toolName === 'AskUserQuestion') {
          followUpText = `关于上面的问题，我的回答是: ${answer}`;
        } else {
          if (answer === 'compact_execute') {
            const updatedSession = this.stateManager.getSession(guildId, threadId)!;
            await this.compactSession(threadId, response.sessionId, updatedSession.cwd, response.sessionId);
            followUpText = '请按照方案执行实现';
          } else if (answer === 'approve') {
            followUpText = '请按照方案执行实现';
          } else if (answer === 'reject') {
            followUpText = '我拒绝了这个方案，请不要执行';
          } else {
            followUpText = answer;
          }
        }

        logger.debug(`Interactive follow-up: ${followUpText.slice(0, 80)}`);

        const latestSession = this.stateManager.getSession(guildId, threadId);
        text = followUpText;
        if (latestSession) session = latestSession;
        mode = undefined;
        continue;
      }

      // 正常流程
      await flushTextBuffer();
      await mq.drain();

      for (const msgId of allProgressMsgIds) {
        mq.delete(threadId, msgId);
      }

      if (sentTextCount === 0 && response.result.trim()) {
        await mq.sendLong(threadId, response.result, { silent: true });
      }

      // 完成标记
      const parts: string[] = [];
      if (response.duration_ms) parts.push(`${(response.duration_ms / 1000).toFixed(1)}s`);
      if (response.usage) {
        const { input_tokens, output_tokens } = response.usage;
        parts.push(`${Math.round((input_tokens + output_tokens) / 1000)}K`);
      }
      const contextWindowSize = response.contextWindow || 200000;
      const snapshotUsage = lastAssistantUsage || (response.usage ? {
        input_tokens: response.usage.input_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
      } : null);
      if (snapshotUsage) {
        const totalInput = snapshotUsage.input_tokens
          + (snapshotUsage.cache_read_input_tokens || 0)
          + (snapshotUsage.cache_creation_input_tokens || 0);
        const usedPct = Math.round((totalInput / contextWindowSize) * 100);
        const indicator = usedPct >= 80 ? '`!!`' : usedPct >= 70 ? '`!`' : '';
        parts.push(`${usedPct}%${indicator}`);
      }
      const summary = parts.length > 0 ? ` (${parts.join(', ')})` : '';

      // 文件变更 HTML 报告
      const skipChangesHtml = mode === 'plan'
        && fileChanges.every(fc => fc.filePath.includes('.claude/plans/') && fc.filePath.endsWith('.md'));
      if (fileChanges.length > 0 && !skipChangesHtml) {
        const html = buildChangesHtml(fileChanges);
        await mq.sendDocument(threadId, html, 'changes.html',
          `${fileChanges.length} file(s) changed`, { silent: true });
      }

      if (mode === 'plan') {
        this.stateManager.setSessionPlanMode(guildId, threadId, true);
        await mq.send(threadId,
          `@everyone Plan generated${summary}\n\n` +
          `Reply "ok" to compact context and execute.\n` +
          `Reply with anything else to continue discussing.`,
          { priority: 'high', embedColor: EmbedColors.GREEN }
        );
      } else {
        await mq.send(threadId, `@everyone Done${summary}`, { priority: 'high', embedColor: EmbedColors.GREEN });
      }

    } catch (error: any) {
      const errorSessionId = session.claudeSessionId;

      await flushTextBuffer().catch(() => {});
      await mq.drain(3000).catch(() => {});

      for (const msgId of allProgressMsgIds) {
        if (msgId !== progressMsgId) mq.delete(threadId, msgId);
      }

      if (fileChanges.length > 0) {
        try {
          const html = buildChangesHtml(fileChanges);
          await mq.sendDocument(threadId, html, 'changes.html',
            `${fileChanges.length} file(s) changed`, { silent: true });
        } catch {}
      }

      if (error instanceof ClaudeExecutionError && error.errorType === ClaudeErrorType.ABORTED) {
        logger.info(`[${session.name}] Task aborted by user`);
        const stoppedText = lastProgressText && lastProgressText !== `Thinking${modeLabel}...`
          ? `Stopped (after ${lastProgressText})`
          : 'Stopped';
        mq.edit(threadId, progressMsgId, stoppedText, { embedColor: EmbedColors.YELLOW });
        return;
      }

      await sendChain.catch(() => {});
      await mq.drain(5000);

      logger.error(`[${session.name}] error:`, error.message);

      let hint = 'Tip: Use /clear to reset session';
      if (error instanceof ClaudeExecutionError) {
        if (error.errorType === ClaudeErrorType.PROCESS_KILLED) {
          hint = 'Session context preserved, you can continue sending messages';
        } else if (error.errorType === ClaudeErrorType.SESSION_RECOVERABLE) {
          this.stateManager.clearSessionClaudeId(guildId, threadId);
          hint = 'Session auto-reset, please resend your message';
        } else if (error.errorType === ClaudeErrorType.FATAL) {
          hint = 'Check bot config (is Claude CLI available?)';
        }
      }

      mq.edit(threadId, progressMsgId, `Error:\n${error.message}\n\n${hint}`, { embedColor: EmbedColors.RED });

      if (this.errorReporter) {
        const sessionInfo = errorSessionId ? ` session=${errorSessionId.slice(0, 8)}` : '';
        this.errorReporter(guildId, threadId, `${session.name}${sessionInfo}`, error);
      }
    }

    break;
    } // end for loop
  }

  /**
   * 后台发送消息到指定 session
   */
  async handleBackgroundChat(
    guildId: string,
    threadId: string,
    message: string,
  ): Promise<void> {
    const session = this.stateManager.getSession(guildId, threadId);
    if (!session) throw new Error('Session not found');
    await this.sendChatInternal(guildId, session, message);
  }

  /**
   * 路由交互式工具到 Discord UI
   */
  private async showInteractivePrompt(
    guildId: string,
    threadId: string,
    toolUseId: string,
    toolName: string,
    input: any,
  ): Promise<string> {
    if (toolName === 'AskUserQuestion') {
      return this.showAskUserQuestion(guildId, threadId, toolUseId, input as AskUserQuestionInput);
    } else if (toolName === 'ExitPlanMode') {
      return this.showExitPlanMode(guildId, threadId, toolUseId, input as ExitPlanModeInput);
    }
    throw new Error(`Unknown interactive tool: ${toolName}`);
  }

  /**
   * 显示 AskUserQuestion: Discord Buttons
   */
  private async showAskUserQuestion(
    guildId: string,
    threadId: string,
    toolUseId: string,
    input: AskUserQuestionInput,
  ): Promise<string> {
    const q = input.questions?.[0];
    if (!q) return 'No question';

    if (!q.options?.length) {
      await this.mq.send(threadId, `@everyone **${q.header || 'Question'}**\n\n${q.question}\n\nPlease type your reply directly.`, { priority: 'high' });
      const { promise } = this.interactionRegistry.register(toolUseId, guildId, threadId);
      this.interactionRegistry.setWaitingCustomText(toolUseId, true);
      return promise;
    }

    const { promise, customIdPrefix } = this.interactionRegistry.register(
      toolUseId, guildId, threadId, q.options.map(o => o.label)
    );

    // 构建问题文本
    let questionText = `**${q.header || 'Please choose'}**\n\n${q.question}\n`;
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      questionText += `\n${i + 1}. **${opt.label}**`;
      if (opt.description) questionText += ` — ${opt.description}`;
    }

    // 构建 Buttons（每行最多 5 个）
    const buttons = q.options.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`input:${customIdPrefix}:${i}`)
        .setLabel(`${i + 1}. ${opt.label}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary)
    );
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`input:${customIdPrefix}:other`)
        .setLabel('Other')
        .setStyle(ButtonStyle.Secondary)
    );

    // 分行（每行最多 5 个按钮）
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
    }

    await this.mq.send(threadId, `@everyone\n${questionText}`, { components: rows as any, priority: 'high' });

    return promise;
  }

  /**
   * 显示 ExitPlanMode: approve/reject Buttons
   */
  private async showExitPlanMode(
    guildId: string,
    threadId: string,
    toolUseId: string,
    input: ExitPlanModeInput,
  ): Promise<string> {
    const { promise, customIdPrefix } = this.interactionRegistry.register(
      toolUseId, guildId, threadId
    );

    let text = '@everyone **Plan ready, waiting for confirmation**\n';
    if (input.allowedPrompts?.length) {
      text += '\nPermissions needed:\n';
      for (const p of input.allowedPrompts) {
        text += `- ${p.tool}: ${p.prompt}\n`;
      }
    }
    text += '\nChoose an action:';

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`input:${customIdPrefix}:approve`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`input:${customIdPrefix}:compact_execute`)
        .setLabel('Compact & Execute')
        .setStyle(ButtonStyle.Primary),
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`input:${customIdPrefix}:reject`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`input:${customIdPrefix}:other`)
        .setLabel('Modify')
        .setStyle(ButtonStyle.Secondary),
    );

    await this.mq.send(threadId, text, { components: [row1 as any, row2 as any], priority: 'high' });

    return promise;
  }

  private shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : filePath;
  }
}
