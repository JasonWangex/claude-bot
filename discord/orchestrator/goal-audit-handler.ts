/**
 * Goal Audit Handler — Goal 完成后自动代码审查
 *
 * Goal 所有子任务完成并合并后，自动对 goal 分支相对于 main 的全部变更
 * 运行 4 阶段代码审查，报告直接输出到 tech lead channel。
 */

import type { GoalDriveState } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import { execGit } from './git-ops.js';
import { logger } from '../utils/logger.js';

/**
 * 触发 Goal 代码审查。Fire-and-forget，不阻塞调用方。
 */
export function triggerGoalAudit(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  guildId: string,
): void {
  (async () => {
    try {
      await runGoalAudit(ctx, state, guildId);
    } catch (err: any) {
      logger.error('[GoalAudit] Unexpected error:', err);
    }
  })();
}

async function runGoalAudit(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  guildId: string,
): Promise<void> {
  // 1. 获取 goal worktree 目录
  const goalWorktreeDir = await ctx.getGoalWorktreeDir(state);
  if (!goalWorktreeDir) {
    await ctx.notifyGoal(state, '[GoalAudit] Goal worktree not found, skipping code review.', 'warning');
    return;
  }

  // 2. 收集 diff 统计信息
  let diffStat = '(unavailable)';
  let changedFilesList = '(unavailable)';
  let changedFilesCount = 0;
  try {
    diffStat = await execGit(
      ['diff', '--stat', 'main...HEAD'],
      goalWorktreeDir,
      'goalAudit: diff stat',
    );
    const filesOutput = await execGit(
      ['diff', '--name-only', 'main...HEAD'],
      goalWorktreeDir,
      'goalAudit: changed files',
    );
    const files = filesOutput.trim().split('\n').filter(Boolean);
    changedFilesCount = files.length;
    changedFilesList = files.slice(0, 30).join('\n') + (files.length > 30 ? `\n... 共 ${files.length} 个文件` : '');
  } catch (err: any) {
    logger.warn(`[GoalAudit] Failed to collect diff stats: ${err.message}`);
  }

  // 3. 设置 audit session（使用 tech lead channel，Opus 模型，CWD = goal worktree）
  const auditChannelId = state.techLeadChannelId ?? state.goalChannelId;
  ctx.deps.stateManager.getOrCreateSession(guildId, auditChannelId, {
    name: `audit-${state.goalName}`,
    cwd: goalWorktreeDir,
  });
  ctx.deps.stateManager.setSessionCwd(guildId, auditChannelId, goalWorktreeDir);
  ctx.deps.stateManager.setSessionModel(guildId, auditChannelId, ctx.deps.config.pipelineOpusModel);

  // 4. 发送通知：审查开始
  await ctx.notifyGoal(state,
    `**代码审查开始** — Goal \`${state.goalName}\` 已完成，正在对分支 \`${state.goalBranch}\` 进行自动代码审查...\n` +
    `变更文件数: ${changedFilesCount}`,
    'info',
  );

  // 5. 构建审查 prompt
  const prompt = buildGoalAuditPrompt(state, diffStat, changedFilesList, changedFilesCount);

  // 6. Fire-and-forget：审查输出直接发到 auditChannelId
  logger.info(`[GoalAudit] Starting code review for goal ${state.goalId} in channel ${auditChannelId}`);
  ctx.deps.messageHandler.handleBackgroundChat(guildId, auditChannelId, prompt, 'goal-audit')
    .then(() => {
      logger.info(`[GoalAudit] Code review completed for goal ${state.goalId}`);
      ctx.appendTimeline(state.goalId, `代码审查完成`, 'success');
    })
    .catch(err => {
      logger.error(`[GoalAudit] handleBackgroundChat error:`, err);
      ctx.notifyGoal(state, `[GoalAudit] 代码审查执行出错: ${err.message}`, 'error').catch(() => {});
    });
}

function buildGoalAuditPrompt(
  state: GoalDriveState,
  diffStat: string,
  changedFilesList: string,
  changedFilesCount: number,
): string {
  return `# Goal 代码审查

Goal **"${state.goalName}"** 的所有子任务已完成，全部代码变更已合并到分支 \`${state.goalBranch}\`。

请对本次 Goal 的全部代码变更进行系统性代码审查，输出完整审查报告。

## 变更信息

- 分支: \`${state.goalBranch}\`
- 变更文件数: ${changedFilesCount}

**Diff 统计:**
\`\`\`
${diffStat}
\`\`\`

**变更文件列表:**
\`\`\`
${changedFilesList}
\`\`\`

## 工作步骤

1. 运行 \`git diff main...HEAD\` 获取完整 diff（当前 CWD 即为 goal worktree）
2. 读取关键变更文件，理解上下文
3. 按以下 4 个阶段执行审查
4. 输出完整审查报告

## 4 阶段审查框架

### Phase 1: 代码质量
扫描：重复代码、嵌套层级 >3、方法 >50 行、死代码、类型安全漏洞、缺失的异步错误处理、魔法值。

### Phase 2: 状态与数据流转
追踪关键实体完整生命周期：DB Schema → Model → Service → API Response → Frontend State → UI
检查：字段命名不一致、序列化边界问题（日期/枚举格式）、过期状态、缺失缓存失效逻辑。

### Phase 3: 前后端交互（如适用）
验证 API 请求/响应契约、错误处理（4xx/5xx → 用户友好消息）、认证流、端点覆盖完整性、防重复提交。

### Phase 4: 逻辑与异常分支
关注：被吞掉的异常、缺失空值检查、边界条件（空/零/最大值）、事务回滚缺失、非幂等重试、资源泄漏。

## 输出格式

每个发现：
\`\`\`
[🔴CRITICAL|🟠HIGH|🟡MEDIUM|🔵LOW] 维度 | file:line
问题 → 建议修复
\`\`\`

最后输出：
1. 汇总表（维度 × 严重性）
2. Top 5 优先修复项（附代码建议）

---

请直接开始审查，输出完整报告。`;
}
