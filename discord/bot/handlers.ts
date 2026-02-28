/**
 * Discord Bot 消息处理器
 * 流式输出：工具调用 → 记录到 text 消息的 Discord Thread；文本输出 → 发新消息（或 edit Thinking...）
 * 文件变更收集：Write/Edit 结果中提取 structuredPatch，任务结束后存入 session_changes 表
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
import { AuthErrorInterceptor } from '../claude/auth-error-interceptor.js';
import { ApiErrorInterceptor } from '../claude/api-error-interceptor.js';
import { MessageQueue, EmbedColors } from './message-queue.js';
import { escapeMarkdown } from './message-utils.js';
import { getDb, SessionChangesRepo } from '../db/index.js';
import {
  StreamEvent,
  AskUserQuestionInput,
  ExitPlanModeInput,
  ClaudeExecutionError,
  ClaudeErrorType,
  Session,
  FileChange,
  ImageAttachment,
  ChatUsageResult,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { downloadAndProcessImage } from '../utils/image-processor.js';
import { getNotifyMention } from '../utils/env.js';

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
  private errorReporter?: (guildId: string | undefined, channelId: string | undefined, source: string, error: any) => void;
  private authErrorInterceptor?: AuthErrorInterceptor;
  private apiErrorInterceptor?: ApiErrorInterceptor;

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

  setErrorReporter(reporter: (guildId: string | undefined, channelId: string | undefined, source: string, error: any) => void): void {
    this.errorReporter = reporter;
  }

  setAuthErrorInterceptor(interceptor: AuthErrorInterceptor): void {
    this.authErrorInterceptor = interceptor;
  }

  setApiErrorInterceptor(interceptor: ApiErrorInterceptor): void {
    this.apiErrorInterceptor = interceptor;
  }

  // Plan mode 确认关键词
  private static PLAN_CONFIRM_WORDS = /^(ok|确认|执行|approve|go|yes|是|开始|实现|implement)$/i;

  // 文本文件下载大小上限（500KB）
  private static MAX_TEXT_FILE_BYTES = 500 * 1024;

  /**
   * 下载文本文件内容，返回字符串；失败或超限返回 null
   */
  static async downloadTextFile(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        logger.warn(`Text file download failed: HTTP ${response.status} ${url}`);
        return null;
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MessageHandler.MAX_TEXT_FILE_BYTES) {
        logger.warn(`Text file too large: ${contentLength} bytes`);
        return null;
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf-8') > MessageHandler.MAX_TEXT_FILE_BYTES) {
        logger.warn(`Text file too large after read: ${Buffer.byteLength(text, 'utf-8')} bytes`);
        return null;
      }
      return text;
    } catch (err) {
      logger.error('Failed to download text file attachment:', err);
      return null;
    }
  }

  /**
   * 处理 Forum Post Thread 中的文字消息
   */
  async handleText(message: Message): Promise<void> {
    const guildId = message.guildId;
    const channelId = message.channelId;
    if (!guildId) return;

    let text = message.content;

    // 处理 Discord 自动将超长消息转为文本文件的情况
    const textFileAttachment = message.attachments.find(
      a => a.contentType?.startsWith('text/plain') || a.name?.endsWith('.txt'),
    );
    if (textFileAttachment) {
      const fileText = await MessageHandler.downloadTextFile(textFileAttachment.url);
      if (fileText === null) {
        // 下载失败，通知用户
        await this.mq.send(channelId, '⚠️ 无法读取你发送的文本文件，请重试。', { silent: true, priority: 'high' });
        return;
      }
      // 文件附件存在时以文件内容为准；若用户同时附带了说明文字则前置
      text = text ? `${text}\n${fileText}` : fileText;
    }

    if (!text) return;

    // 用户交互时取消待发的等待消息
    this.stateManager.cancelWaitingMessage(channelId);

    // // 前缀 → Claude skill 命令
    if (text.startsWith('//')) {
      text = text.slice(1);
    } else if (text.startsWith('/')) {
      return; // slash command, ignore
    }

    const threadName = message.channel && 'name' in message.channel ? (message.channel as any).name : `thread-${channelId}`;

    let session = this.stateManager.getOrCreateSession(guildId, channelId, {
      name: threadName,
      cwd: this.stateManager.getGuildDefaultCwd(guildId),
    });

    // Reply 路由：多 link 时必须 reply 指定目标 session
    const activeLinks = this.stateManager.getActiveLinks(channelId);
    if (activeLinks.length > 1) {
      const replyToId = message.reference?.messageId;
      if (!replyToId) {
        await this.mq.send(channelId,
          `This channel has ${activeLinks.length} active sessions. Please **reply** to a message from the session you want to talk to.`,
          { silent: true, priority: 'high' }
        );
        return;
      }
      // 通过被 reply 的消息 ID 找到对应 link → claudeSessionId
      const link = this.stateManager.findLinkByDiscordMessageId(replyToId);
      if (!link) {
        // 该消息不属于任何活跃 link（如 reply 到进度消息或非 Done 消息）
        await this.mq.send(channelId,
          'Cannot route: please **reply** to a **Done** message from the target session.',
          { silent: true, priority: 'high' }
        );
        return;
      }
      if (link.claudeSessionId !== session.claudeSessionId) {
        // 目标是另一个 session，切换本次调用的 claudeSessionId（不持久化，仅本次路由）
        const targetLink = activeLinks.find(l => l.claudeSessionId === link.claudeSessionId);
        if (targetLink?.claudeSessionId) {
          session = { ...session, claudeSessionId: targetLink.claudeSessionId };
        } else if (targetLink) {
          // link 存在但 claudeSessionId 尚未初始化（session 还未和 Claude 建立过对话）
          await this.mq.send(channelId,
            'Target session is not ready yet (no CLI session established). Please send a message first to initialize it.',
            { silent: true, priority: 'high' }
          );
          return;
        }
      }
    }

    // Claude 正在处理时，直接注入 stdin，无需排队
    // 注意：ExitPlanMode / AskUserQuestion 等待期间 isRunning=true，但不能注入——
    // Claude 在等 tool_result，注入新 user 消息会破坏状态，必须跳过。
    const lockKey = StateManager.channelLockKey(guildId, channelId);
    if (this.claudeClient.isRunning(lockKey) && !this.interactionRegistry.hasPendingForChannel(channelId)) {
      const injected = this.claudeClient.injectMessage(lockKey, text);
      if (injected) {
        logger.info(`[${session.name}] Message injected to running Claude process`);
        await this.mq.send(channelId,
          '↪ Claude is working — your message will be processed next',
          { silent: true, priority: 'high' });
        return;
      }
      // 注入失败（进程刚退出）→ 继续正常流程
    }

    // Plan mode 确认
    if (session.planMode) {
      if (MessageHandler.PLAN_CONFIRM_WORDS.test(text.trim())) {
        await this.executePlanApproval(guildId, channelId, session);
        return;
      }
      await this.sendChatInternal(guildId, session, text, 'plan', undefined, message.id);
      return;
    }

    await this.sendChatInternal(guildId, session, text, undefined, undefined, message.id);
  }

  /**
   * 处理图片消息
   */
  async handlePhoto(message: Message): Promise<void> {
    const guildId = message.guildId;
    const channelId = message.channelId;
    if (!guildId) return;

    const attachments = message.attachments.filter(a => a.contentType?.startsWith('image/'));
    if (attachments.size === 0) return;

    const threadName = message.channel && 'name' in message.channel ? (message.channel as any).name : `thread-${channelId}`;
    const session = this.stateManager.getOrCreateSession(guildId, channelId, {
      name: threadName,
      cwd: this.stateManager.getGuildDefaultCwd(guildId),
    });

    const processingMsgId = await this.mq.send(channelId, 'Processing image...', { silent: true });

    try {
      const firstAttachment = attachments.first()!;
      const image = await downloadAndProcessImage(firstAttachment.url);
      logger.info(`[${session.name}] Photo processed: ${image.mediaType}, ${Math.round(image.data.length * 3 / 4 / 1024)}KB`);

      this.mq.delete(channelId, processingMsgId);

      const caption = message.content?.trim() || 'Please look at this image';

      // Claude 正在处理时，直接注入 stdin（pending 交互期间跳过，同 handleMessage）
      const lockKey = StateManager.channelLockKey(guildId, channelId);
      if (this.claudeClient.isRunning(lockKey) && !this.interactionRegistry.hasPendingForChannel(channelId)) {
        const injected = this.claudeClient.injectMessage(lockKey, caption, [image]);
        if (injected) {
          logger.info(`[${session.name}] Image injected to running Claude process`);
          await this.mq.send(channelId,
            '↪ Claude is working — your image will be processed next',
            { silent: true, priority: 'high' });
          return;
        }
      }

      await this.sendChatInternal(guildId, session, caption, undefined, [image], message.id);
    } catch (error: any) {
      logger.error(`[${session.name}] Photo processing error:`, error);
      this.mq.edit(channelId, processingMsgId, `Image processing failed: ${error.message}`);
    }
  }

  /**
   * 公开方法：通过 guildId/threadId 发送消息
   */
  async sendChatByIds(
    guildId: string,
    channelId: string,
    text: string,
  ): Promise<void> {
    const session = this.stateManager.getOrCreateSession(guildId, channelId, {
      name: `thread-${channelId}`,
      cwd: this.stateManager.getGuildDefaultCwd(guildId),
    });
    const anchorMsgId = await this.mq.getLastMessageId(channelId).catch(() => null);
    await this.sendChatInternal(guildId, session, text, undefined, undefined, anchorMsgId);
  }

  /**
   * Compact session context, show progress in thread
   */
  private async compactSession(channelId: string, sessionId: string, cwd: string, lockKey: string): Promise<void> {
    const compactMsgId = await this.mq.send(channelId, 'Compacting context...', { silent: true });
    try {
      await this.claudeClient.compact(sessionId, cwd, lockKey);
      this.mq.edit(channelId, compactMsgId, 'Context compacted. Executing plan...');
    } catch (error: any) {
      this.mq.edit(channelId, compactMsgId, `Compact failed (${error.message}), executing directly...`);
    }
  }

  /**
   * Plan 确认后执行
   */
  private async executePlanApproval(guildId: string, channelId: string, session: Session): Promise<void> {
    this.stateManager.setSessionPlanMode(guildId, channelId, false);

    if (!session.claudeSessionId) {
      await this.mq.send(channelId, 'No active context. Please send `/plan` again.', { silent: true });
      return;
    }

    const lockKey = StateManager.channelLockKey(guildId, channelId);
    await this.compactSession(channelId, session.claudeSessionId, session.cwd, lockKey);

    await this.sendChatInternal(guildId, session, '请按照上面的方案执行实现');
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
    anchorMsgId?: string | null,
  ): Promise<ChatUsageResult> {
    const channelId = session.channelId;
    const isHidden = session.hidden ?? false;
    const MAX_INTERACTIVE_ROUNDS = 5;
    const totalUsage: ChatUsageResult = {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      total_cost_usd: 0, duration_ms: 0,
    };

    for (let round = 0; round < MAX_INTERACTIVE_ROUNDS; round++) {

    if (!isHidden) this.mq.resetThreadState(channelId);
    this.stateManager.clearDoneSentAt(channelId);
    logger.info(`[${session.name}] Message:`, text.substring(0, 100));
    this.stateManager.updateSessionMessage(guildId, channelId, text, 'user');

    const lockKey = StateManager.channelLockKey(guildId, channelId);

    let queuedMsgId: string | null = null; // 排队等待时的提示消息
    let toolUseCount = 0;
    const startTime = Date.now();
    let sentTextCount = 0;
    let compactPreTokens: number | null = null;
    let lastAssistantUsage: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
    let sendChain = Promise.resolve();

    // Text 缓冲
    let textBuffer: string[] = [];
    let lastTextFlushTime = 0;
    const TEXT_FLUSH_INTERVAL = 1000;

    // 交互式工具拦截
    const interactiveState: { pending: { toolName: string; toolUseId: string; input: any } | null } = { pending: null };

    // 文件变更收集
    const fileChanges: FileChange[] = [];

    const mq = this.mq;

    // thread 相关状态
    let currentToolThreadId: string | null = null; // 当前 tool 消息的 thread channel ID
    let threadAnchorMsgId: string | null = anchorMsgId ?? null; // 下一批 tools 挂载的 anchor 消息 ID
    const failedAnchors = new Set<string>(); // 建 thread 失败的 anchor，不再重试
    const createdThreadIds = new Set<string>(); // 本次 session 创建的所有 thread，session 结束时归档
    const messagesWithThreads = new Set<string>(); // 已有 thread 的 anchor 消息，cleanup 时不删除

    const cleanupProgressMessages = async () => {
      try {
        await mq.drain(5000);
      } catch {
        logger.warn(`[${session.name}] Drain timeout`);
      }
    };

    const flushTextBuffer = async () => {
      if (textBuffer.length === 0) return;
      const drained = textBuffer.splice(0);
      // hidden session：只清缓冲区，不发 Discord 消息
      if (isHidden) return;
      const newContent = drained.join('\n\n');
      logger.debug(`[${session.name}] flushText: ${drained.length} chunks, ${newContent.length} chars`);

      try {
        // 始终发新消息，不 edit 已有消息
        const msgId = await mq.sendLong(channelId, newContent, { priority: 'high', silent: true });
        threadAnchorMsgId = msgId; // 新消息作为后续 tool calls 的 thread anchor
        currentToolThreadId = null; // 新 anchor，下次 tool 调用时建新 thread
        lastTextFlushTime = Date.now();
        logger.debug(`[${session.name}] flushText: sent msg ${msgId.slice(-6)} (${newContent.length} chars)`);
      } catch (e) {
        logger.warn(`[${session.name}] flushText failed, restoring ${drained.length} chunks:`, e);
        textBuffer.unshift(...drained);
        throw e;
      }
    };

    const elapsed = () => `${Math.round((Date.now() - startTime) / 1000)}s`;

    // 进度回调
    const onProgress = (event: StreamEvent) => {
      const subtype = (event as any).subtype;
      if (event.type === 'system' && subtype === 'queued') {
        if (!isHidden) {
          const pos = (event as any).queue_position || '?';
          // 显示 Interrupt & Send Now 按钮，让用户可以中断当前任务
          const interruptButton = new ButtonBuilder()
            .setCustomId(`interrupt:${lockKey.slice(0, 20)}`)
            .setLabel('Interrupt & Send Now')
            .setStyle(ButtonStyle.Primary);
          const cancelButton = new ButtonBuilder()
            .setCustomId(`cancel:${lockKey.slice(0, 20)}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);
          const queuedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(interruptButton, cancelButton);
          mq.send(channelId, `Queued (position ${pos})...`, { components: [queuedRow as any], embedColor: EmbedColors.GRAY, silent: true, priority: 'high' })
            .then(id => { queuedMsgId = id; })
            .catch(() => {});
        }
        return;
      }
      if (event.type === 'system' && subtype === 'lock_acquired') {
        // 消费中断上下文（清除状态）
        this.claudeClient.consumeInterruptContext(lockKey);
        // 删除排队提示消息
        if (!isHidden && queuedMsgId) {
          mq.delete(channelId, queuedMsgId);
          queuedMsgId = null;
        }
        return;
      }
      if (event.type === 'system' && subtype === 'session_reset') {
        this.stateManager.clearSessionClaudeId(guildId, channelId);
        return;
      }
      if (event.type === 'system' && subtype === 'retrying') {
        return;
      }
      if (event.type === 'system' && subtype === 'stall_warning') {
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
        lastTextFlushTime = 0;
        currentToolThreadId = null;
        threadAnchorMsgId = anchorMsgId ?? null; // 重置到初始触发消息
        failedAnchors.clear();
        messagesWithThreads.clear();
        return;
      }
      // stdin 注入多轮时：上一轮 result 已到，下一轮即将开始
      // 立即重置本轮 UI 状态
      if (event.type === 'system' && subtype === 'turn_boundary') {
        sentTextCount = 0;
        toolUseCount = 0;
        compactPreTokens = null;
        lastAssistantUsage = null;
        interactiveState.pending = null;
        lastTextFlushTime = 0;
        currentToolThreadId = null;
        threadAnchorMsgId = null;
        failedAnchors.clear();
        messagesWithThreads.clear();

        sendChain = sendChain
          .then(() => flushTextBuffer())
          .catch(e => logger.warn(`[${session.name}] Turn boundary flush failed:`, e));
        mq.trackAsync(() => sendChain);
        return;
      }

      // 压缩状态事件: {type:"system", subtype:"status", status:"compacting"|null}
      if (event.type === 'system' && subtype === 'status' && event.status === 'compacting') {
        return;
      }
      // compact_boundary 携带 compact_metadata
      if (event.compact_metadata) {
        compactPreTokens = event.compact_metadata.pre_tokens;
      }
      if (subtype === 'compact_boundary') {
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
          if (change) {
            const existing = fileChanges.find(c => c.filePath === change!.filePath);
            if (existing) {
              // 合并同一文件的多次修改
              if (change.type === 'create') {
                // 新的 create 覆盖旧记录（文件被重建）
                existing.type = 'create';
                existing.content = change.content;
                existing.patches = [...(existing.patches ?? []), ...(change.patches ?? [])];
              } else {
                // update：追加 patches
                existing.patches = [...(existing.patches ?? []), ...(change.patches ?? [])];
              }
            } else {
              fileChanges.push(change);
            }
          }
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

            let detailHeader = '';
            let detailBody = '';
            if (block.input) {
              if (block.name === 'Read' && block.input.file_path) {
                detailHeader = `: ${this.shortPath(block.input.file_path)}`;
              } else if (block.name === 'Bash' && block.input.command) {
                detailHeader = `: ${block.input.command.slice(0, 60)}`;
              } else if (block.name === 'Grep' && block.input.pattern) {
                detailHeader = `: ${block.input.pattern}`;
              } else if (block.name === 'Glob' && block.input.pattern) {
                detailHeader = `: ${block.input.pattern}`;
              } else if (block.name === 'Edit' && block.input.file_path) {
                detailHeader = `: ${this.shortPath(block.input.file_path)}`;
                const oldStr = (block.input.old_string || '').slice(0, 200);
                const newStr = (block.input.new_string || '').slice(0, 200);
                const diffLines = [
                  ...oldStr.split('\n').map((l: string) => `- ${l}`),
                  ...newStr.split('\n').map((l: string) => `+ ${l}`),
                ].join('\n');
                detailBody = `\`\`\`diff\n${diffLines}\n\`\`\``;
              } else if (block.name === 'Write' && block.input.file_path) {
                detailHeader = `: ${this.shortPath(block.input.file_path)}`;
                const content = (block.input.content || '').slice(0, 500);
                detailBody = `\`\`\`\n${content}\n\`\`\``;
              }
            }

            const toolMsg = detailBody
              ? `[${toolUseCount}] ${toolLabel}${detailHeader} (${elapsed()})\n${detailBody}`
              : `[${toolUseCount}] ${toolLabel}${detailHeader} (${elapsed()})`;

            if (!isHidden) {
              sendChain = sendChain.then(async () => {
                const anchorId = threadAnchorMsgId; // 读取当前最新 anchor（前序 flushText 完成后）
                if (!anchorId) return;
                if (!currentToolThreadId) {
                  if (failedAnchors.has(anchorId)) return; // 已知失败的 anchor，跳过
                  try {
                    currentToolThreadId = await mq.createThread(channelId, anchorId, 'Tool calls');
                    createdThreadIds.add(currentToolThreadId);
                    messagesWithThreads.add(anchorId);
                  } catch (e) {
                    logger.warn(`[${session.name}] Thread creation failed:`, e);
                    failedAnchors.add(anchorId); // 标记，后续工具不再重试
                    return;
                  }
                }
                mq.send(currentToolThreadId, toolMsg);
              }).catch(e => logger.warn(`[${session.name}] Tool thread post failed:`, e));
              mq.trackAsync(() => sendChain);
            }
            // 回写进度到 executor，用于中断上下文保存
            this.claudeClient.updateProgressInfo(lockKey, toolMsg, toolUseCount);
          } else if (block.type === 'text' && block.text) {
            if (interactiveState.pending) continue;

            const textContent = block.text.trim();
            if (!textContent) continue;

            sentTextCount++;

            textBuffer.push(textContent);
            const now = Date.now();
            if (now - lastTextFlushTime >= TEXT_FLUSH_INTERVAL) {
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
        // 排队等待后延迟解析：前一个任务完成并更新 claudeSessionId 后，用最新值 resume，
        // 避免排队消息用发送时的旧 session ID（可能是 undefined）创建新 session。
        resolveSessionId: () => this.stateManager.getSession(guildId, channelId)?.claudeSessionId,
        cwd: session.cwd,
        lockKey,
        permissionMode: mode === 'plan' ? 'plan' : undefined,
        model: effectiveModel,
        guildId,
        channelId,
        images,
        sessionName: session.name,
        worktreeBranch: session.worktreeBranch,
      }, onProgress);
      images = undefined;

      this.stateManager.setSessionClaudeId(guildId, channelId, response.sessionId);

      // 成功响应：重置该 channel 的连续错误计数
      this.authErrorInterceptor?.onSuccess(guildId, channelId);
      this.apiErrorInterceptor?.onSuccess(guildId, channelId);

      this.stateManager.updateSessionMessage(guildId, channelId, response.result, 'assistant');
      logger.info(`[${session.name}] Response length:`, response.result.length);

      // 累加本轮 usage
      totalUsage.input_tokens += response.usage?.input_tokens ?? 0;
      totalUsage.output_tokens += response.usage?.output_tokens ?? 0;
      totalUsage.cache_read_input_tokens += response.usage?.cache_read_input_tokens ?? 0;
      totalUsage.cache_creation_input_tokens += response.usage?.cache_creation_input_tokens ?? 0;
      totalUsage.total_cost_usd += response.total_cost_usd ?? 0;
      totalUsage.duration_ms += response.duration_ms ?? 0;

      // 交互式工具拦截（hidden session 无法交互，跳过 Discord UI 路径）
      if (interactiveState.pending && !isHidden) {
        const pi = interactiveState.pending;

        await sendChain;
        await flushTextBuffer();
        await mq.drain(10000);

        await cleanupProgressMessages();

        // 补发内容
        let planSent = false;
        if (pi.toolName === 'ExitPlanMode') {
          const planFile = fileChanges.find(fc => fc.filePath.includes('.claude/plans/') && fc.filePath.endsWith('.md'));
          if (planFile) {
            try {
              const planContent = readFileSync(planFile.filePath, 'utf-8').trim();
              if (planContent) {
                await mq.sendLong(channelId, planContent, { priority: 'high', silent: true });
                planSent = true;
              }
            } catch {}
          }
        }
        if (!planSent && sentTextCount === 0 && response.result.trim()) {
          await mq.sendLong(channelId, response.result, { priority: 'high', silent: true });
        }

        if (planSent) fileChanges.length = 0;

        // 显示 Discord Buttons 等待用户输入
        const answer = await this.showInteractivePrompt(
          guildId, channelId, pi.toolUseId, pi.toolName, pi.input
        );

        // 构造后续消息
        let followUpText: string;
        if (pi.toolName === 'AskUserQuestion') {
          if (answer === '__timeout__') {
            followUpText = '用户没有在规定时间内回复这个问题，请跳过该问题，自行选择最佳选项继续执行';
          } else {
            followUpText = `关于上面的问题，我的回答是: ${answer}`;
          }
        } else {
          if (answer === 'compact_execute') {
            const updatedSession = this.stateManager.getSession(guildId, channelId)!;
            await this.compactSession(channelId, response.sessionId, updatedSession.cwd, response.sessionId);
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

        const latestSession = this.stateManager.getSession(guildId, channelId);
        text = followUpText;
        if (latestSession) {
          // 保留 reply 路由后的 claudeSessionId，防止 interactive 循环丢失路由结果
          session = { ...latestSession, claudeSessionId: session.claudeSessionId };
        }
        mode = undefined;
        continue;
      }

      // 正常流程：先等 sendChain 完成（防止竞态），再 flush 残留文字
      logger.debug(`[${session.name}] Completion: sentTextCount=${sentTextCount}, textBuffer=${textBuffer.length}, result=${response.result.length} chars`);
      if (!isHidden) {
        try {
          await sendChain;
          await flushTextBuffer();
          await mq.drain();
        } catch (e) {
          logger.warn(`[${session.name}] Completion drain error:`, e);
        }

        await cleanupProgressMessages();

        if (sentTextCount === 0 && response.result.trim()) {
          logger.debug(`[${session.name}] No text sent during stream, sending result as fallback`);
          await mq.sendLong(channelId, response.result, { silent: true });
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

        // 文件变更存入数据库（取代原先生成 HTML 上传 OSS/Discord）
        const skipChanges = mode === 'plan'
          && fileChanges.every(fc => fc.filePath.includes('.claude/plans/') && fc.filePath.endsWith('.md'));
        let changesLink = '';
        if (fileChanges.length > 0 && !skipChanges) {
          try {
            new SessionChangesRepo(getDb()).save(channelId, fileChanges);
            const webUrl = process.env.WEB_URL?.replace(/\/$/, '');
            if (webUrl) {
              changesLink = `\n[查看变更](${webUrl}/channels/${channelId}?tab=changes)`;
            }
          } catch (err) {
            logger.warn('Failed to save session changes to DB:', err);
          }
        }

        // 多 link 时消息标头（让用户知道是哪个 session 发的）
        const allActiveLinks = this.stateManager.getActiveLinks(channelId);
        const modelName = session.model?.match(/sonnet|opus|haiku/i)?.[0]?.toLowerCase() ?? 'claude';
        const sessionPrefix = allActiveLinks.length > 1
          ? `[${modelName} | ${session.claudeSessionId?.slice(0, 8) ?? '?'}] `
          : '';

        let doneMsgId: string;
        if (mode === 'plan') {
          this.stateManager.setSessionPlanMode(guildId, channelId, true);
          doneMsgId = await mq.send(channelId,
            `✅ ${sessionPrefix}${getNotifyMention()} Plan generated${summary}\n\n` +
            `Reply "ok" to compact context and execute.\n` +
            `Reply with anything else to continue discussing.`,
            { priority: 'high' }
          );
        } else {
          doneMsgId = await mq.send(channelId, `✅ ${sessionPrefix}${getNotifyMention()} Done${summary}${changesLink}`, { priority: 'high' });
        }
        this.stateManager.setDoneSentAt(channelId);

        // 记录最新 Discord 消息 ID 到 link（reply 路由用）
        // 通过 claudeSessionId 查找对应 link 的 UUID（兼容 reply 路由后 session.id 已被替换的情况）
        if (doneMsgId && session.claudeSessionId) {
          this.stateManager.updateLinkLastMessageId(channelId, session.claudeSessionId, doneMsgId);
        }
      }

    } catch (error: any) {
      const errorSessionId = session.claudeSessionId;

      // 先等 sendChain 完成（与正常流程一致），再 flush 残留文字
      await sendChain.catch(() => {});
      await flushTextBuffer().catch(() => {});
      if (!isHidden) await mq.drain(3000).catch(() => {});

      await cleanupProgressMessages();

      if (!isHidden && fileChanges.length > 0) {
        try {
          new SessionChangesRepo(getDb()).save(channelId, fileChanges);
        } catch (saveErr) {
          logger.warn('Failed to save session changes to DB (error path):', saveErr);
        }
      }

      if (error instanceof ClaudeExecutionError && error.errorType === ClaudeErrorType.ABORTED) {
        logger.info(`[${session.name}] Task aborted by user`);
        // 保存 abort 时已知的 session ID，让下次发消息能 resume 而不是创建新 session
        if (error.sessionId) {
          try {
            this.stateManager.setSessionClaudeId(guildId, channelId, error.sessionId);
          } catch (persistErr) {
            logger.warn(`[${session.name}] Failed to persist session after abort:`, persistErr);
          }
        }
        if (!isHidden) {
          mq.send(channelId, 'Stopped', { embedColor: EmbedColors.YELLOW, priority: 'high', silent: true });
        }
        return totalUsage;
      }

      if (error instanceof ClaudeExecutionError && error.errorType === ClaudeErrorType.AUTH_ERROR) {
        logger.warn(`[${session.name}] Auth error (403), triggering interceptor`);
        // 主动关闭 active session：CLI 异常退出时 Stop hook 不触发，session 会卡在 'active'，
        // 导致 checkOrphanedTasks 跳过该任务，轻推永远不触发
        this.stateManager.closeActiveSessionForChannel(channelId);
        this.authErrorInterceptor?.handleAuthError(guildId, channelId);
        // re-throw 让调用方（如 executeTaskPipeline）感知到 AUTH_ERROR，
        // 避免 orchestrator 把未完成的任务错误标记为 completed
        throw error;
      }

      if (error instanceof ClaudeExecutionError && error.errorType === ClaudeErrorType.API_ERROR) {
        logger.warn(`[${session.name}] API error (500), triggering interceptor`);
        this.stateManager.closeActiveSessionForChannel(channelId);
        const willRetry = this.apiErrorInterceptor?.handleApiError(guildId, channelId) ?? false;
        if (willRetry) {
          // re-throw 让调用方保持任务为 running 状态，等待拦截器重试
          throw error;
        }
        // 超出最大重试次数：落入下方正常错误处理，任务将被标记为失败
      }

      if (!isHidden) await mq.drain(5000);

      logger.error(`[${session.name}] error:`, error);

      if (!isHidden) {
        let hint = 'Tip: Use /clear to reset session';
        if (error instanceof ClaudeExecutionError) {
          if (error.errorType === ClaudeErrorType.PROCESS_KILLED) {
            hint = 'Session context preserved, you can continue sending messages';
          } else if (error.errorType === ClaudeErrorType.SESSION_RECOVERABLE) {
            this.stateManager.clearSessionClaudeId(guildId, channelId);
            hint = 'Session auto-reset, please resend your message';
          } else if (error.errorType === ClaudeErrorType.FATAL) {
            hint = 'Check bot config (is Claude CLI available?)';
          }
        }
        mq.send(channelId, `Error:\n${error.message}\n\n${hint}`, { embedColor: EmbedColors.RED, priority: 'high', silent: true });
      } else if (error instanceof ClaudeExecutionError && error.errorType === ClaudeErrorType.SESSION_RECOVERABLE) {
        this.stateManager.clearSessionClaudeId(guildId, channelId);
      }

      if (this.errorReporter) {
        const sessionInfo = errorSessionId ? ` session=${errorSessionId.slice(0, 8)}` : '';
        this.errorReporter(guildId, channelId, `${session.name}${sessionInfo}`, error);
      }
    } finally {
      // 归档本次 session 创建的所有 thread，避免超出频道活跃 thread 数量上限
      for (const threadId of createdThreadIds) {
        mq.archiveThread(threadId).catch(e => logger.warn(`[${session.name}] archiveThread ${threadId} failed:`, e));
      }
    }

    break;
    } // end for loop

    return totalUsage;
  }

  /**
   * 后台发送消息到指定 session
   * @param source 调用来源标识（如 'qdev', 'code-audit', 'orchestrator'）。
   *               有值则显示 [source] 指示 embed；未传则显示 [BackgroundChat]。
   */
  async handleBackgroundChat(
    guildId: string,
    channelId: string,
    message: string,
    source?: string,
  ): Promise<ChatUsageResult> {
    const session = this.stateManager.getSession(guildId, channelId);
    if (!session) throw new Error('Session not found');

    // 向频道发送来源指示 embed（hidden session 无真实 Discord channel，跳过）
    // 等待发送完成以获取消息 ID，用于将 tool thread 挂载到该 indicator 消息上
    let anchorMsgId: string | null = null;
    if (!session.hidden) {
      const label = source ?? 'BackgroundChat';
      const preview = message.replace(/\n+/g, ' ');
      const indicator = preview.length > 100 ? `${preview.slice(0, 100)}…` : preview;
      anchorMsgId = await this.mq.send(channelId, `**[${label}]** ${indicator}`, {
        embedColor: EmbedColors.GRAY,
        priority: 'high',
        silent: true,
      }).catch(err => {
        logger.warn('[handleBackgroundChat] indicator send failed:', err);
        return null;
      });
    }

    return this.sendChatInternal(guildId, session, message, undefined, undefined, anchorMsgId);
  }

  /**
   * 路由交互式工具到 Discord UI
   */
  private async showInteractivePrompt(
    guildId: string,
    channelId: string,
    toolUseId: string,
    toolName: string,
    input: any,
  ): Promise<string> {
    if (toolName === 'AskUserQuestion') {
      return this.showAskUserQuestion(guildId, channelId, toolUseId, input as AskUserQuestionInput);
    } else if (toolName === 'ExitPlanMode') {
      return this.showExitPlanMode(guildId, channelId, toolUseId, input as ExitPlanModeInput);
    }
    throw new Error(`Unknown interactive tool: ${toolName}`);
  }

  /**
   * 显示 AskUserQuestion: Discord Buttons
   */
  private async showAskUserQuestion(
    guildId: string,
    channelId: string,
    toolUseId: string,
    input: AskUserQuestionInput,
  ): Promise<string> {
    const q = input.questions?.[0];
    if (!q) return 'No question';

    if (!q.options?.length) {
      await this.mq.send(channelId, `${getNotifyMention()} **${q.header || 'Question'}**\n\n${q.question}\n\nPlease type your reply directly.`, { priority: 'high' });
      const { promise } = this.interactionRegistry.register(toolUseId, guildId, channelId);
      this.interactionRegistry.setWaitingCustomText(toolUseId, true);
      return promise;
    }

    const { promise, customIdPrefix } = this.interactionRegistry.register(
      toolUseId, guildId, channelId, q.options.map(o => o.label)
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

    await this.mq.send(channelId, `${getNotifyMention()}\n${questionText}`, { components: rows as any, priority: 'high' });

    return promise;
  }

  /**
   * 显示 ExitPlanMode: approve/reject Buttons
   */
  private async showExitPlanMode(
    guildId: string,
    channelId: string,
    toolUseId: string,
    input: ExitPlanModeInput,
  ): Promise<string> {
    const { promise, customIdPrefix } = this.interactionRegistry.register(
      toolUseId, guildId, channelId, undefined, { noTimeout: true }
    );

    let text = `${getNotifyMention()} **Plan ready, waiting for confirmation**\n`;
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

    await this.mq.send(channelId, text, { components: [row1 as any, row2 as any], priority: 'high' });

    return promise;
  }

  private shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : filePath;
  }
}
