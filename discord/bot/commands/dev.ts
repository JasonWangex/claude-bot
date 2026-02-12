/**
 * Dev Workflow 命令: /qdev, /idea, /commit, /merge
 * 开发工作流快捷命令，通过 Skill 文件或 Claude 后台进程执行
 */

import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  SlashCommandBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { generateBranchName } from '../../utils/git-utils.js';
import { generateTopicTitle } from '../../utils/llm.js';
import { forkTaskCore } from '../../utils/fork-task.js';
import { logger } from '../../utils/logger.js';
import type { CommandDeps } from './types.js';
import { requireAuth, requireThread } from './utils.js';

export const devCommands = [
  new SlashCommandBuilder()
    .setName('qdev')
    .setDescription('Quick Dev: create branch + task + start Claude')
    .addStringOption(opt =>
      opt.setName('description').setDescription('Task description').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('idea')
    .setDescription('Record an idea or develop an existing one')
    .addStringOption(opt =>
      opt.setName('content').setDescription('Idea content (empty to list existing ideas)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('commit')
    .setDescription('Review and commit code changes')
    .addStringOption(opt =>
      opt.setName('message').setDescription('Optional commit message hint').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('merge')
    .setDescription('Merge worktree branch to main and cleanup')
    .addStringOption(opt =>
      opt.setName('target').setDescription('Thread name or branch name to merge').setRequired(true)
    ),
];

export async function handleDevCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  switch (interaction.commandName) {
    case 'qdev':
      return handleQdev(interaction, deps);
    case 'idea':
      return handleIdea(interaction, deps);
    case 'commit':
      return handleCommit(interaction, deps);
    case 'merge':
      return handleMerge(interaction, deps);
  }
}

// ========== /qdev ==========

async function handleQdev(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const threadId = interaction.channelId;
  const description = interaction.options.getString('description', true);
  const { stateManager, client, config, messageHandler } = deps;

  const session = stateManager.getSession(guildId, threadId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  try {
    // 1. 并行生成分支名和 thread 标题
    await interaction.editReply('Generating branch name...');
    const [branchName, threadTitle] = await Promise.all([
      generateBranchName(description),
      generateTopicTitle(description),
    ]);

    // 2. 获取 root session
    await interaction.editReply(`Branch: \`${branchName}\`\nCreating worktree and thread...`);
    const rootSession = stateManager.getRootSession(guildId, threadId);
    const parentThreadId = rootSession?.threadId ?? threadId;

    // 3. 从当前 channel 的 parentId 获取 Category
    const channel = interaction.channel;
    let categoryId: string | undefined;
    if (channel && 'parentId' in channel && channel.parentId) {
      const parent = await client.channels.fetch(channel.parentId);
      if (parent && parent.type === ChannelType.GuildCategory) {
        categoryId = parent.id;
      }
    }
    if (!categoryId) {
      await interaction.editReply('This command must be used in a task channel (under a Category).');
      return;
    }

    // 4. Fork: 创建 worktree + Text Channel + session
    const forkResult = await forkTaskCore(guildId, parentThreadId, branchName, categoryId, {
      stateManager,
      client,
      worktreesDir: config.worktreesDir,
    }, threadTitle);

    // 5. 发送任务描述到新 thread
    await interaction.editReply(`Branch: \`${branchName}\`\nSending task to new thread...`);
    const newChannel = await client.channels.fetch(forkResult.threadId);
    if (newChannel && newChannel.isTextBased() && 'send' in newChannel) {
      await (newChannel as any).send(description);
    }

    // 6. 触发 Claude 处理（fire-and-forget）
    messageHandler.handleBackgroundChat(guildId, forkResult.threadId, description).catch((err) => {
      logger.error('qdev background chat failed:', err.message);
    });

    // 7. 最终结果
    await interaction.editReply(
      `**Task created**\n\n` +
      `Branch: \`${forkResult.branchName}\`\n` +
      `Thread: <#${forkResult.threadId}>\n` +
      `Working directory: \`${forkResult.cwd}\`\n\n` +
      `Claude is processing the task in the new thread...`
    );
  } catch (error: any) {
    logger.error('qdev failed:', error);
    await interaction.editReply(`qdev failed: ${error.message}`);
  }
}

// ========== /idea ==========

async function handleIdea(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const threadId = interaction.channelId;
  const args = interaction.options.getString('content') || '';
  const { stateManager, messageHandler, messageQueue } = deps;

  const session = stateManager.getSession(guildId, threadId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  // 加载 skill 文件
  const skillPath = join(homedir(), '.claude/skills/idea/SKILL.md');
  let skillContent: string;
  try {
    skillContent = await readFile(skillPath, 'utf-8');
  } catch {
    await interaction.reply({ content: 'Skill file not found: ~/.claude/skills/idea/SKILL.md', ephemeral: true });
    return;
  }

  // 提取 frontmatter 之后的内容
  const bodyMatch = skillContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  const prompt = (bodyMatch ? bodyMatch[1] : skillContent)
    .replace('{{SKILL_ARGS}}', args);

  if (args) {
    // 记录模式：独立进程，不占用 session
    await interaction.reply('Recording idea...');
    spawnSkillProcess('idea', prompt, session.cwd, threadId, messageQueue, {
      allowedTools: 'Bash,mcp__claude_ai_Notion__notion-create-pages,mcp__claude_ai_Notion__notion-search',
    });
  } else {
    // 列表模式：通过当前 session 交互（支持用户选择）
    await interaction.reply('Querying undeveloped ideas...');
    messageHandler.handleBackgroundChat(guildId, threadId, prompt).catch((err) => {
      logger.error('idea list mode failed:', err.message);
      messageQueue.sendLong(threadId, `idea query failed: ${err.message}`).catch(() => {});
    });
  }
}

// ========== /commit ==========

async function handleCommit(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const threadId = interaction.channelId;
  const message = interaction.options.getString('message') || '';
  const { stateManager, messageHandler, messageQueue } = deps;

  const session = stateManager.getSession(guildId, threadId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  const skillPath = join(homedir(), '.claude/skills/commit/SKILL.md');
  let skillContent: string;
  try {
    skillContent = await readFile(skillPath, 'utf-8');
  } catch {
    await interaction.reply({ content: 'Skill file not found: ~/.claude/skills/commit/SKILL.md', ephemeral: true });
    return;
  }

  const bodyMatch = skillContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  const prompt = (bodyMatch ? bodyMatch[1] : skillContent)
    .replace('{{SKILL_ARGS}}', message);

  await interaction.reply({
    content: `Reviewing and committing code...${message ? `\nHint: ${message}` : ''}`,
    ephemeral: true,
  });

  messageHandler.handleBackgroundChat(guildId, threadId, prompt).catch((err) => {
    logger.error('commit failed:', err.message);
    messageQueue.sendLong(threadId, `commit failed: ${err.message}`).catch(() => {});
  });
}

// ========== /merge ==========

async function handleMerge(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;

  const guildId = interaction.guildId!;
  const target = interaction.options.getString('target', true);
  const { stateManager, messageQueue } = deps;

  // 查找匹配的 session
  const allSessions = stateManager.getAllSessions(guildId);
  const targetSession = allSessions.find(s => s.worktreeBranch === target)
    || allSessions.find(s => s.name === target)
    || allSessions.find(s => s.name.toLowerCase().includes(target.toLowerCase()));

  if (!targetSession) {
    await interaction.reply({ content: `No matching thread found: "${target}"`, ephemeral: true });
    return;
  }

  if (!targetSession.worktreeBranch) {
    await interaction.reply({ content: `Thread "${targetSession.name}" is not a worktree branch, cannot merge.`, ephemeral: true });
    return;
  }

  await interaction.deferReply();

  // 预计算 main worktree 路径
  let mainCwd: string;
  try {
    const { execGit } = await import('../../orchestrator/git-ops.js');
    const stdout = await execGit(['worktree', 'list'], targetSession.cwd, 'merge: list worktrees');
    const mainLine = stdout.split('\n').find(line => /\[(main|master)\]/.test(line));
    if (!mainLine) {
      await interaction.editReply('Cannot find main/master branch worktree.');
      return;
    }
    mainCwd = mainLine.split(/\s+/)[0];
  } catch (err: any) {
    await interaction.editReply(`Failed to resolve main worktree: ${err.message}`);
    return;
  }

  // 加载 skill
  const skillPath = join(homedir(), '.claude/skills/merge/SKILL.md');
  let skillContent: string;
  try {
    skillContent = await readFile(skillPath, 'utf-8');
  } catch {
    await interaction.editReply('Skill file not found: ~/.claude/skills/merge/SKILL.md');
    return;
  }

  const bodyMatch = skillContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  const prompt = (bodyMatch ? bodyMatch[1] : skillContent)
    .replaceAll('{{TARGET_TOPIC_ID}}', targetSession.threadId)
    .replaceAll('{{TARGET_BRANCH}}', targetSession.worktreeBranch)
    .replaceAll('{{TARGET_CWD}}', targetSession.cwd)
    .replaceAll('{{MAIN_CWD}}', mainCwd);

  // 确定回复的 channel（优先当前 task channel，否则目标 channel）
  const currentSession = stateManager.getSession(guildId, interaction.channelId);
  const replyThreadId = currentSession
    ? interaction.channelId
    : targetSession.threadId;

  await interaction.editReply(
    `Merging: **${targetSession.name}**\n` +
    `Branch: \`${targetSession.worktreeBranch}\`\n` +
    `Working directory: \`${targetSession.cwd}\``
  );

  spawnSkillProcess('merge', prompt, mainCwd, replyThreadId, messageQueue, { maxTurns: 5 });
}

// ========== spawnSkillProcess ==========

/**
 * 启动独立 claude -p 进程执行 skill
 * 不占用 session/lock，进程结束自动销毁
 */
const SKILL_PROCESS_TIMEOUT = 30 * 60 * 1000; // 30 minutes

function spawnSkillProcess(
  skillName: string,
  prompt: string,
  cwd: string,
  replyChannelId: string,
  messageQueue: import('../message-queue.js').MessageQueue,
  options?: { maxTurns?: number; allowedTools?: string },
): void {
  const child = spawn('claude', [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--allowedTools', options?.allowedTools ?? 'Bash',
    '--max-turns', String(options?.maxTurns ?? 15),
    '--no-session-persistence',
  ], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let killed = false;
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const timeout = setTimeout(() => {
    killed = true;
    child.kill('SIGTERM');
    logger.warn(`${skillName} process timed out after ${SKILL_PROCESS_TIMEOUT / 1000}s, killing`);
  }, SKILL_PROCESS_TIMEOUT);

  child.on('exit', async (code: number | null) => {
    clearTimeout(timeout);
    try {
      if (killed) {
        await messageQueue.sendLong(replyChannelId, `${skillName} timed out after ${SKILL_PROCESS_TIMEOUT / 60000} minutes`);
      } else if (code === 0) {
        let result: string;
        try {
          result = JSON.parse(stdout).result || stdout;
        } catch {
          result = stdout.trim();
        }
        if (result) {
          await messageQueue.sendLong(replyChannelId, result);
        }
      } else {
        const errMsg = stderr.trim() || `exit code ${code}`;
        await messageQueue.sendLong(replyChannelId, `${skillName} failed: ${errMsg}`);
      }
    } catch (e: any) {
      logger.error(`${skillName} result delivery failed:`, e.message);
    }
  });

  child.on('error', (err: Error) => {
    clearTimeout(timeout);
    messageQueue.sendLong(replyChannelId, `${skillName} launch failed: ${err.message}`).catch(() => {});
  });
}

