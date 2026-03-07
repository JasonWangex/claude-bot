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

// ==================== 任务失败 retry 按钮 ====================

/**
 * 生成任务失败后的操作按钮组：Retry（在原 channel 恢复执行）
 */
export function buildTaskFailedButtons(goalId: string, taskId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`goal:retry_task:${goalId}:${taskId}`)
      .setLabel('🔄 Retry')
      .setStyle(ButtonStyle.Primary),
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
