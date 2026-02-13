/**
 * JSONL 解析器 — 从 Claude CLI 输出的 .jsonl 文件提取结构化交互数据
 *
 * 事件类型:
 * - system (subtype=init): 初始化，含 model, session_id, tools
 * - assistant: 文本回复或工具调用 (message.content[].type = 'text' | 'tool_use')
 * - user: 用户输入或工具结果 (message.content[].type = 'tool_result')
 * - result (subtype=success): 最终结果，含 total_cost_usd, num_turns 等
 *
 * Turn 定义:
 * - 一个 turn 由一个或多个 assistant 事件（相同 message.id）+ 紧随的 user 事件组成
 * - 每个 turn 产生两条记录: role=assistant 和 role=user
 * - 最后一个 turn 可能只有 assistant 没有 user（纯文本回复）
 */

import { readFileSync } from 'node:fs';
import type { InteractionLogRow } from '../types/db.js';

// ================================================================
// JSONL 事件类型定义
// ================================================================

interface JsonlEvent {
  type: 'system' | 'assistant' | 'user' | 'result';
  subtype?: string;
  message?: {
    id: string;
    role: 'user' | 'assistant';
    model?: string;
    content: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      name?: string; // tool_use 的工具名
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string }>; // tool_result 的内容
      is_error?: boolean;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  parent_tool_use_id?: string | null;
  total_cost_usd?: number;
}

// ================================================================
// 内部数据结构
// ================================================================

/** 单个 turn 的原始数据 */
interface TurnData {
  turnIndex: number;
  messageId: string;
  assistantEvents: JsonlEvent[];
  userEvents: JsonlEvent[];
}

// ================================================================
// 解析主函数
// ================================================================

/**
 * 解析 JSONL 文件，返回 InteractionLogRow 数组
 *
 * @param jsonlPath 归档后的 JSONL 文件绝对路径
 * @param relativePath JSONL 文件相对路径（用于存库）
 * @param sessionId Claude CLI session_id
 * @returns InteractionLogRow[] 可直接写入 DB 的记录数组
 */
export function parseJsonlFile(
  jsonlPath: string,
  relativePath: string,
  sessionId: string,
): Omit<InteractionLogRow, 'id'>[] {
  // 读取文件并解析每一行
  const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter((line) => line.trim());
  const events: JsonlEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (e: any) {
      // 单行损坏不影响其他行
      console.warn(`[JSONL Parser] 跳过损坏行: ${e.message}`);
    }
  }

  // 过滤掉不需要的事件
  const filteredEvents = events.filter((e) => {
    // 跳过 system 和 result 事件
    if (e.type === 'system' || e.type === 'result') return false;
    // 跳过子代理事件
    if (e.parent_tool_use_id) return false;
    return true;
  });

  // 按 message.id 分组构建 turns
  const turns = buildTurns(filteredEvents);

  // 为每个 turn 生成 InteractionLogRow 记录
  const rows: Omit<InteractionLogRow, 'id'>[] = [];
  const now = Date.now();

  for (const turn of turns) {
    // assistant 记录
    const assistantRow = buildAssistantRow(turn, sessionId, relativePath, now);
    rows.push(assistantRow);

    // user 记录（如果有）
    if (turn.userEvents.length > 0) {
      const userRow = buildUserRow(turn, sessionId, relativePath, now);
      rows.push(userRow);
    }
  }

  return rows;
}

// ================================================================
// Turn 构建逻辑
// ================================================================

/**
 * 按 message.id 分组，构建 turn 序列
 *
 * 规则:
 * - 遇到新的 assistant message.id → 新 turn 开始
 * - 同一 message.id 的多个 assistant 事件 → 合并到同一 turn
 * - user 事件关联到当前 turn
 */
function buildTurns(events: JsonlEvent[]): TurnData[] {
  const turns: TurnData[] = [];
  let currentTurn: TurnData | null = null;
  let turnIndex = 0;

  for (const event of events) {
    if (event.type === 'assistant') {
      const messageId = event.message?.id || '';

      // 新的 message.id → 新 turn
      if (!currentTurn || currentTurn.messageId !== messageId) {
        if (currentTurn) {
          turns.push(currentTurn);
          turnIndex++;
        }
        currentTurn = {
          turnIndex,
          messageId,
          assistantEvents: [event],
          userEvents: [],
        };
      } else {
        // 同一 message.id → 合并到当前 turn
        currentTurn.assistantEvents.push(event);
      }
    } else if (event.type === 'user' && currentTurn) {
      // user 事件关联到当前 turn
      currentTurn.userEvents.push(event);
    }
  }

  // 最后一个 turn
  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}

// ================================================================
// Row 构建逻辑
// ================================================================

/**
 * 构建 assistant 记录
 */
function buildAssistantRow(
  turn: TurnData,
  sessionId: string,
  jsonlPath: string,
  timestamp: number,
): Omit<InteractionLogRow, 'id'> {
  // 合并所有 assistant 事件的内容
  const allContent: Array<{ type: string; text?: string; name?: string }> = [];
  for (const event of turn.assistantEvents) {
    if (event.message?.content) {
      allContent.push(...event.message.content);
    }
  }

  // 提取 content_type 和 summary_text
  const hasText = allContent.some((c) => c.type === 'text');
  const hasToolUse = allContent.some((c) => c.type === 'tool_use');
  let contentType = 'text';
  if (hasText && hasToolUse) {
    contentType = 'text+tool_use';
  } else if (hasToolUse) {
    contentType = 'tool_use';
  }

  const summaryText = buildAssistantSummary(allContent);

  // 提取 model 和 usage（取最后一个事件的值，因为它是累积的）
  const lastEvent = turn.assistantEvents[turn.assistantEvents.length - 1];
  const model = lastEvent.message?.model || null;
  const usage = lastEvent.message?.usage;

  return {
    session_id: sessionId,
    turn_index: turn.turnIndex,
    role: 'assistant',
    content_type: contentType,
    summary_text: summaryText,
    model,
    tokens_input: usage?.input_tokens || null,
    tokens_output: usage?.output_tokens || null,
    cost_usd: null, // 按计划，cost_usd 在 assistant 记录中留 null
    jsonl_path: jsonlPath,
    created_at: timestamp,
  };
}

/**
 * 构建 user 记录
 */
function buildUserRow(
  turn: TurnData,
  sessionId: string,
  jsonlPath: string,
  timestamp: number,
): Omit<InteractionLogRow, 'id'> {
  // 合并所有 user 事件的内容
  const allContent: Array<{ type: string; is_error?: boolean }> = [];
  for (const event of turn.userEvents) {
    if (event.message?.content) {
      allContent.push(...event.message.content);
    }
  }

  // user 事件通常是 tool_result
  const summaryText = buildUserSummary(allContent);

  return {
    session_id: sessionId,
    turn_index: turn.turnIndex,
    role: 'user',
    content_type: 'tool_result',
    summary_text: summaryText,
    model: null,
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    jsonl_path: jsonlPath,
    created_at: timestamp,
  };
}

// ================================================================
// 摘要生成逻辑
// ================================================================

/**
 * 生成 assistant 记录的摘要文本
 *
 * 规则:
 * - 纯文本: 截取前 200 字符
 * - tool_use: 列出工具名 "Read(file.ts), Edit(file.ts), Bash"
 * - 混合: "<截断文本> | Read(file.ts), Edit(file.ts)"
 */
function buildAssistantSummary(
  content: Array<{ type: string; text?: string; name?: string }>,
): string {
  const textParts: string[] = [];
  const toolNames: string[] = [];

  for (const c of content) {
    if (c.type === 'text' && c.text) {
      textParts.push(c.text);
    } else if (c.type === 'tool_use' && c.name) {
      toolNames.push(c.name);
    }
  }

  const textSummary = textParts.join(' ').slice(0, 200);
  const toolSummary = toolNames.join(', ');

  if (textSummary && toolSummary) {
    return `${textSummary} | ${toolSummary}`;
  } else if (textSummary) {
    return textSummary;
  } else if (toolSummary) {
    return toolSummary;
  } else {
    return '';
  }
}

/**
 * 生成 user 记录的摘要文本
 *
 * 规则:
 * - tool_result: "tool_result x3 (1 error)"
 * - 纯文本: 截取前 200 字符
 */
function buildUserSummary(content: Array<{ type: string; is_error?: boolean }>): string {
  const toolResultCount = content.filter((c) => c.type === 'tool_result').length;
  const errorCount = content.filter((c) => c.type === 'tool_result' && c.is_error).length;

  if (toolResultCount > 0) {
    if (errorCount > 0) {
      return `tool_result x${toolResultCount} (${errorCount} error)`;
    } else {
      return `tool_result x${toolResultCount}`;
    }
  }

  // 如果不是 tool_result（罕见情况，如纯文本用户输入）
  return '';
}
