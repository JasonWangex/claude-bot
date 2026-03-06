/**
 * Goal body 工具函数
 *
 * 从 replanner.ts 提取的纯工具函数，用于渲染和更新 Goal body 中的子任务列表。
 */

import type { GoalTask } from '../types/index.js';

export function renderTaskListMarkdown(tasks: GoalTask[]): string {
  const statusEmoji: Record<string, string> = {
    pending: '⏳',
    dispatched: '📤',
    running: '🔄',
    completed: '✅',
    failed: '❌',
    blocked: '🚧',
    blocked_feedback: '💬',
    paused: '⏸️',
    cancelled: '🚫',
    skipped: '⏭️',
  };

  const lines: string[] = [
    '## 子任务',
    '',
    '| ID | 类型 | 描述 | Phase | 状态 |',
    '|---|---|---|---|---|',
  ];

  for (const task of tasks) {
    const emoji = statusEmoji[task.status] || '';
    const phase = task.phase ?? 1;
    const desc = task.description.replace(/\|/g, '\\|');
    lines.push(`| ${task.id} | ${task.type} | ${desc} | ${phase} | ${emoji} ${task.status} |`);
  }

  return lines.join('\n');
}

/**
 * 更新 Goal body 中的子任务列表部分。
 *
 * 如果 body 中已有 "## 子任务" 段落，则替换；否则追加。
 */
export function updateGoalBodyWithTasks(body: string | null, tasks: GoalTask[]): string {
  const taskSection = renderTaskListMarkdown(tasks);

  if (!body) return taskSection;

  // 匹配 "## 子任务" 到下一个 ## 标题或文件末尾
  const sectionRegex = /## 子任务[\s\S]*?(?=\n##\s|$)/;
  if (sectionRegex.test(body)) {
    return body.replace(sectionRegex, taskSection);
  }

  // 没有现有子任务段落 → 追加
  return body.trimEnd() + '\n\n' + taskSection;
}
