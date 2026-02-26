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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

// ==================== 按钮 customId 前缀 ====================

export const GOAL_BUTTON_PREFIX = 'goal:';

// ==================== Replan 审批按钮（高影响） ====================

/**
 * 生成高影响 replan 审批按钮组：批准 / 修改后批准 / 回滚
 */
export function buildReplanApprovalButtons(goalId: string, checkpointId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`goal:approve_replan:${goalId}`)
      .setLabel('✅ 批准执行')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`goal:approve_with_mods:${goalId}`)
      .setLabel('✏️ 修改后批准')
      .setStyle(ButtonStyle.Primary),
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

// ==================== 修改后批准 Modal ====================

/** Modal customId 前缀（与 goal button 区分） */
export const GOAL_MODAL_PREFIX = 'goal_modal:';

/**
 * 生成「修改后批准」Modal
 *
 * 预填当前 pendingReplan 的变更 JSON，用户修改后提交。
 * Discord Modal TextInput 最大 4000 字符，超长时截断并提示用户精简。
 */
export function buildApproveWithModsModal(
  goalId: string,
  currentChangesJson: string,
): ModalBuilder {
  // 确保不超 4000 字符
  const truncated = currentChangesJson.length > 3900
    ? currentChangesJson.slice(0, 3900) + '\n// ... 已截断，请精简后提交'
    : currentChangesJson;

  const modal = new ModalBuilder()
    .setCustomId(`${GOAL_MODAL_PREFIX}approve_with_mods:${goalId}`)
    .setTitle('修改计划变更');

  const changesInput = new TextInputBuilder()
    .setCustomId('changes_json')
    .setLabel('编辑变更 JSON（修改后提交即执行）')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(truncated)
    .setRequired(true)
    .setMaxLength(4000);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(changesInput),
  );

  return modal;
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
