/**
 * Goal 通知按钮工厂
 *
 * 生成各场景的 Discord ActionRow 按钮组件，用于 Goal thread 通知增强。
 * 按钮 customId 统一使用 `goal:` 前缀，由 discord.ts 路由到 GoalOrchestrator。
 *
 * customId 格式：goal:<action>:<goalId>[:<extra>]
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

// ==================== 按钮 customId 前缀 ====================

export const GOAL_BUTTON_PREFIX = 'goal:';

// ==================== Replan 审批按钮（高影响） ====================

/**
 * 生成高影响 replan 审批按钮组：批准 / 拒绝 / 回滚
 */
export function buildReplanApprovalButtons(goalId: string, checkpointId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`goal:approve_replan:${goalId}`)
      .setLabel('✅ 批准执行')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`goal:reject_replan:${goalId}`)
      .setLabel('🚫 拒绝变更')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`goal:rollback:${goalId}:${checkpointId}`)
      .setLabel('⏪ 回滚')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

// ==================== Replan 自动执行后的回滚按钮（低/中影响） ====================

/**
 * 生成低/中影响自动变更后的回滚按钮
 */
export function buildReplanRollbackButton(goalId: string, checkpointId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`goal:rollback:${goalId}:${checkpointId}`)
      .setLabel('⏪ 回滚此变更')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

// ==================== 回滚确认按钮 ====================

/**
 * 生成回滚确认/取消按钮组
 */
export function buildRollbackConfirmButtons(goalId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`goal:confirm_rollback:${goalId}`)
      .setLabel('✅ 确认回滚')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`goal:cancel_rollback:${goalId}`)
      .setLabel('🚫 取消')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

// ==================== 解析工具 ====================

export interface GoalButtonAction {
  action: string;
  goalId: string;
  extra?: string;
}

/**
 * 解析 goal: 前缀的按钮 customId
 * @returns 解析结果，null 表示不是 goal 按钮
 */
export function parseGoalButtonId(customId: string): GoalButtonAction | null {
  if (!customId.startsWith(GOAL_BUTTON_PREFIX)) return null;

  const parts = customId.slice(GOAL_BUTTON_PREFIX.length).split(':');
  if (parts.length < 2) return null;

  return {
    action: parts[0],
    goalId: parts[1],
    extra: parts.length > 2 ? parts.slice(2).join(':') : undefined,
  };
}
