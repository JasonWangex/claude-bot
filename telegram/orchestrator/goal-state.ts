/**
 * Goal Drive 状态持久化
 *
 * 状态文件存储在 data/goals/<goalId>.json
 * 负责读写和解析子任务结构
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import type { GoalDriveState, GoalTask, GoalTaskType } from '../types/index.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

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
 * 含非 ASCII（中文等）时用 claude haiku 翻译为英文短名，
 * 翻译失败则 fallback 到 hash。
 */
export async function translateToBranchName(name: string): Promise<string> {
  if (!hasNonAscii(name)) {
    return sanitizeToAscii(name).slice(0, 40);
  }

  try {
    const { stdout } = await execFileAsync('claude', [
      '-p',
      `将以下名称转为简短的 git 分支名（纯英文小写+连字符，不超过30字符，只输出分支名，不要任何其他内容）: ${name}`,
      '--model', 'haiku',
      '--output-format', 'text',
    ], { timeout: 15000 });

    const result = sanitizeToAscii(stdout.trim());
    if (result.length >= 3) {
      logger.debug(`[GoalState] Translated branch name: "${name}" → "${result}"`);
      return result.slice(0, 40);
    }
  } catch (err: any) {
    logger.warn(`[GoalState] Failed to translate branch name "${name}": ${err.message}`);
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
