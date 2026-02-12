/**
 * Goal Drive 工具函数
 *
 * 负责解析子任务结构和生成 git 分支名。
 * 持久化已迁移到 IGoalRepo (SQLite)。
 */

import type { GoalTask, GoalTaskType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { chatCompletion } from '../utils/llm.js';

const VALID_GOAL_TASK_TYPES: GoalTaskType[] = ['代码', '手动', '调研'];

/**
 * 从 Goal Skill 传入的结构化子任务列表解析为 GoalTask[]
 *
 * 预期输入格式（由 Claude 实例解析 Notion 后生成）:
 * ```json
 * [
 *   { "id": "t1", "description": "创建数据模型", "type": "代码", "depends": [], "phase": 1 },
 *   { "id": "t2", "description": "实现 API", "type": "代码", "depends": ["t1"], "phase": 2 }
 * ]
 * ```
 */
export function parseTasks(raw: Array<{
  id: string;
  description: string;
  type?: string;
  depends?: string[];
  phase?: number;
}>): GoalTask[] {
  return raw.map(t => {
    const rawType = t.type || '代码';
    const type: GoalTaskType = VALID_GOAL_TASK_TYPES.includes(rawType as GoalTaskType)
      ? (rawType as GoalTaskType)
      : '代码';
    return {
      id: t.id,
      description: t.description,
      type,
      depends: t.depends || [],
      phase: t.phase,
      status: 'pending' as const,
    };
  });
}

/** 用 sanitize 提取 ASCII 部分并清理 */
function sanitizeToAscii(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 检测是否含非 ASCII 字符 */
function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

/** 用 hash 生成短后缀（fallback） */
function shortHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
}

/**
 * 将名称转为合法的 git 分支名
 *
 * 含非 ASCII（中文等）时用 DeepSeek 翻译为英文短名，
 * 翻译失败则 fallback 到 hash。
 */
export async function translateToBranchName(name: string): Promise<string> {
  if (!hasNonAscii(name)) {
    return sanitizeToAscii(name).slice(0, 40);
  }

  const result = await chatCompletion(
    `将以下名称转为简短的 git 分支名（纯英文小写+连字符，不超过30字符，只输出分支名，不要任何其他内容）: ${name}`,
  );
  if (result) {
    const clean = sanitizeToAscii(result);
    if (clean.length >= 3) {
      logger.debug(`[GoalState] Translated branch name: "${name}" → "${clean}"`);
      return clean.slice(0, 40);
    }
  }

  // Fallback: ASCII 部分 + hash
  const ascii = sanitizeToAscii(name);
  const prefix = ascii.length >= 3 ? ascii.slice(0, 30) : '';
  return `${prefix ? prefix + '-' : ''}${shortHash(name)}`;
}

/** 将 Goal name 转为合法的 git 分支名 */
export async function goalNameToBranch(name: string): Promise<string> {
  const branchName = await translateToBranchName(name);
  return `goal/${branchName || 'unnamed'}`;
}
