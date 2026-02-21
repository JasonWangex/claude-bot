import type { Migration } from '../migrate.js';

/**
 * 将 orchestrator.replan prompt 从直接返回 JSON 迁移到事件驱动协议。
 *
 * 旧版：要求 LLM 直接 respond with JSON（chatCompletion 直接解析）
 * 新版：要求 reviewer session 调用 bot_task_event 写入 replan.result 事件
 *
 * 与 review.task_result / review.phase_result 保持一致的架构。
 */

const NEW_TEMPLATE = `You are a task replanner for a software development goal orchestrator.
Your job is to analyze feedback from a subtask and produce a structured plan update.

## Goal
Name: {{GOAL_NAME}}
{{GOAL_BODY}}
{{COMPLETION_CRITERIA}}

## Current Tasks
{{CURRENT_TASKS}}

## Replan Trigger
Task: {{TRIGGER_TASK_ID}}
Feedback type: {{FEEDBACK_TYPE}}
Reason: {{FEEDBACK_REASON}}
{{FEEDBACK_DETAILS}}
{{COMPLETED_DIFF_STATS}}
## Constraints
1. **NEVER modify completed or skipped tasks** — their IDs: {{IMMUTABLE_COMPLETED}}
2. **NEVER modify running or dispatched tasks** — their IDs: {{IMMUTABLE_RUNNING}}
3. New task IDs must not collide with existing IDs
4. Tasks are ordered by phase (phase 1 runs first, then phase 2, etc.). Tasks in the same phase run in parallel.
5. Keep changes minimal — only modify what the feedback necessitates
6. Preserve the overall goal direction

## Output
Call \`bot_task_event\` with:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "replan.result"
- \`payload\`:
\`\`\`json
{
  "changes": [
    { "action": "add", "task": { "id": "t8", "description": "...", "type": "代码", "phase": 3, "complexity": "simple" } },
    { "action": "modify", "taskId": "t5", "updates": { "description": "new desc", "phase": 2, "complexity": "complex" } },
    { "action": "remove", "taskId": "t7", "reason": "superseded by t8" }
  ],
  "reasoning": "Explanation of why these changes are needed",
  "impactLevel": "low" | "medium" | "high"
}
\`\`\`

Impact levels (assessed by affected pending tasks):
- low: affects ≤1 pending task (description tweaks, phase adjustment)
- medium: affects 2-3 pending tasks (task additions/removals, but overall direction unchanged)
- high: affects ≥4 pending tasks, OR significant restructuring with both add+remove that changes direction
Note: low/medium changes are auto-applied; high requires user approval.

Valid task types: 代码, 手动, 调研, 占位
Task granularity: split by **feature/functionality**, NOT by technical layer. One feature = one task, even if it touches frontend + backend + API.
Valid complexity (for 代码 tasks): "simple" (straightforward logic, has patterns to follow) or "complex" (needs architecture design or cross-module coordination). Default: "simple"
Valid actions: add, modify, remove

If no changes are needed, call \`bot_task_event\` with: \`{ "changes": [], "reasoning": "...", "impactLevel": "low" }\``;

const NEW_VARIABLES = JSON.stringify([
  'GOAL_NAME', 'GOAL_BODY', 'COMPLETION_CRITERIA', 'CURRENT_TASKS',
  'TRIGGER_TASK_ID', 'FEEDBACK_TYPE', 'FEEDBACK_REASON', 'FEEDBACK_DETAILS',
  'COMPLETED_DIFF_STATS', 'IMMUTABLE_COMPLETED', 'IMMUTABLE_RUNNING', 'TASK_ID',
]);

const OLD_TEMPLATE = `You are a task replanner for a software development goal orchestrator.
Your job is to analyze feedback from a subtask and produce a structured JSON plan update.

## Goal
Name: {{GOAL_NAME}}
{{GOAL_BODY}}
{{COMPLETION_CRITERIA}}

## Current Tasks
{{CURRENT_TASKS}}

## Replan Trigger
Task: {{TRIGGER_TASK_ID}}
Feedback type: {{FEEDBACK_TYPE}}
Reason: {{FEEDBACK_REASON}}
{{FEEDBACK_DETAILS}}
{{COMPLETED_DIFF_STATS}}
## Constraints
1. **NEVER modify completed or skipped tasks** — their IDs: {{IMMUTABLE_COMPLETED}}
2. **NEVER modify running or dispatched tasks** — their IDs: {{IMMUTABLE_RUNNING}}
3. New task IDs must not collide with existing IDs
4. Tasks are ordered by phase (phase 1 runs first, then phase 2, etc.). Tasks in the same phase run in parallel.
5. Keep changes minimal — only modify what the feedback necessitates
6. Preserve the overall goal direction

## Output Format
Respond with a single JSON object (no markdown fences, no extra text):

{
  "changes": [
    { "action": "add", "task": { "id": "t8", "description": "...", "type": "代码", "phase": 3, "complexity": "simple" } },
    { "action": "modify", "taskId": "t5", "updates": { "description": "new desc", "phase": 2, "complexity": "complex" } },
    { "action": "remove", "taskId": "t7", "reason": "superseded by t8" }
  ],
  "reasoning": "Explanation of why these changes are needed",
  "impactLevel": "low" | "medium" | "high"
}

Impact levels (assessed by affected pending tasks):
- low: affects ≤1 pending task (description tweaks, phase adjustment)
- medium: affects 2-3 pending tasks (task additions/removals, but overall direction unchanged)
- high: affects ≥4 pending tasks, OR significant restructuring with both add+remove that changes direction
Note: low/medium changes are auto-applied; high requires user approval.

Valid task types: 代码, 手动, 调研, 占位
Task granularity: split by **feature/functionality**, NOT by technical layer. One feature = one task, even if it touches frontend + backend + API.
Valid complexity (for 代码 tasks): "simple" (straightforward logic, has patterns to follow) or "complex" (needs architecture design or cross-module coordination). Default: "simple"
Valid actions: add, modify, remove

If no changes are needed, return: { "changes": [], "reasoning": "...", "impactLevel": "low" }`;

const OLD_VARIABLES = JSON.stringify([
  'GOAL_NAME', 'GOAL_BODY', 'COMPLETION_CRITERIA', 'CURRENT_TASKS',
  'TRIGGER_TASK_ID', 'FEEDBACK_TYPE', 'FEEDBACK_REASON', 'FEEDBACK_DETAILS',
  'COMPLETED_DIFF_STATS', 'IMMUTABLE_COMPLETED', 'IMMUTABLE_RUNNING',
]);

const migration: Migration = {
  version: 25,
  name: 'update_replan_prompt_to_event_protocol',

  up(db) {
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, variables = ?, description = ?, updated_at = ?
      WHERE key = 'orchestrator.replan'
    `).run(NEW_TEMPLATE, NEW_VARIABLES, '分析 feedback 并通过 bot_task_event 上报结构化计划更新', Date.now());
  },

  down(db) {
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, variables = ?, description = ?, updated_at = ?
      WHERE key = 'orchestrator.replan'
    `).run(OLD_TEMPLATE, OLD_VARIABLES, '分析 feedback 并产出结构化 JSON 计划更新', Date.now());
  },
};

export default migration;
