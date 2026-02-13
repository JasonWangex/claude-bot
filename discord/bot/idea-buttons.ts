/**
 * Idea 交互按钮工厂
 *
 * 按钮 customId 统一使用 `idea:` 前缀，由 discord.ts 路由到处理逻辑。
 * customId 格式：idea:<action>:<ideaId>
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

export const IDEA_BUTTON_PREFIX = 'idea:';

export interface IdeaButtonAction {
  action: string;
  ideaId: string;
}

/**
 * 解析 idea: 前缀的按钮 customId
 * @returns 解析结果，null 表示不是 idea 按钮
 */
export function parseIdeaButtonId(customId: string): IdeaButtonAction | null {
  if (!customId.startsWith(IDEA_BUTTON_PREFIX)) return null;

  const parts = customId.slice(IDEA_BUTTON_PREFIX.length).split(':');
  if (parts.length < 2) return null;

  return {
    action: parts[0],
    ideaId: parts[1],
  };
}

/**
 * 为 idea 列表生成「推进」按钮组
 * 每行最多 5 个按钮，最多 5 行（Discord 限制）
 */
export function buildIdeaPromoteButtons(
  ideas: { id: string; name: string }[],
): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = ideas.slice(0, 25).map((idea, i) =>
    new ButtonBuilder()
      .setCustomId(`idea:promote:${idea.id}`)
      .setLabel(`${i + 1}. 推进`)
      .setStyle(ButtonStyle.Primary),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

/**
 * 为单个 idea 生成「推进方式」选择按钮（第二步）
 * - 快速开发 (qdev)
 * - 推进为 Goal
 */
export function buildIdeaAdvanceChoiceButtons(
  ideaId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`idea:qdev:${ideaId}`)
      .setLabel('快速开发 (qdev)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`idea:goal:${ideaId}`)
      .setLabel('推进为 Goal')
      .setStyle(ButtonStyle.Primary),
  );
  return [row];
}
