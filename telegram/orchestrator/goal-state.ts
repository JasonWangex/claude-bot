/**
 * Goal Drive 状态持久化
 *
 * 状态文件存储在 data/goals/<goalId>.json
 * 负责读写和解析子任务结构
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GoalDriveState, GoalTask, GoalTaskType } from '../types/index.js';
import { logger } from '../utils/logger.js';

const GOALS_DIR = join(process.cwd(), 'data', 'goals');

function ensureDir(): void {
  mkdirSync(GOALS_DIR, { recursive: true });
}

function stateFilePath(goalId: string): string {
  // Notion page ID 含连字符，保留原样
  return join(GOALS_DIR, `${goalId}.json`);
}

export function loadState(goalId: string): GoalDriveState | null {
  try {
    const raw = readFileSync(stateFilePath(goalId), 'utf-8');
    return JSON.parse(raw) as GoalDriveState;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn(`[GoalState] Failed to load state for ${goalId}: ${err.message}`);
    }
    return null;
  }
}

export function saveState(state: GoalDriveState): void {
  ensureDir();
  state.updatedAt = Date.now();
  writeFileSync(stateFilePath(state.goalId), JSON.stringify(state, null, 2));
}

/** 加载所有正在运行的 Goal drive 状态 */
export function loadAllRunningStates(): GoalDriveState[] {
  ensureDir();
  const results: GoalDriveState[] = [];
  try {
    const files = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = readFileSync(join(GOALS_DIR, file), 'utf-8');
        const state = JSON.parse(raw) as GoalDriveState;
        if (state.status === 'running') {
          results.push(state);
        }
      } catch (err: any) {
        logger.warn(`[GoalState] Skipping corrupted state file ${file}: ${err.message}`);
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return results;
}

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
  return raw.map(t => ({
    id: t.id,
    description: t.description,
    type: (t.type || '代码') as GoalTaskType,
    depends: t.depends || [],
    phase: t.phase,
    status: 'pending' as const,
  }));
}

/** 将 Goal name 转为合法的 git 分支名 */
export function goalNameToBranch(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `goal/${sanitized || 'unnamed'}`;
}
