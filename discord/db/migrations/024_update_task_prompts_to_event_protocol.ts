import type { Migration } from '../migrate.js';

/**
 * Migration 024: 将任务 prompt 从文件协议迁移到 bot_task_event 协议，并同步 replan 格式
 *
 * 背景：task_events 表引入后，seed 文件已更新为使用 bot_task_event 上报事件，
 * 但 DB 中的旧 prompt 仍使用文件协议（feedback/*.json），导致 task_events 表始终为空。
 * 同时 migration 019 移除了 depends 机制，replan prompt 也需同步更新。
 *
 * 更新：
 * - orchestrator.task.requirements: 移除"写文件"指令，改为调用 bot_task_event
 * - orchestrator.task.feedback_protocol: 移除文件协议，改为 Completion + Feedback Protocol
 * - orchestrator.task.research_rules: 移除"写文件"指令，改为调用 bot_task_event
 * - orchestrator.replan: 移除 depends/reorder（migration 019 已删除依赖机制），改为纯 phase 模型
 */
const migration: Migration = {
  version: 24,
  name: 'update_task_prompts_to_event_protocol',

  up(db) {
    const now = Date.now();

    const update = db.prepare(`
      UPDATE prompt_configs SET template = ?, updated_at = ? WHERE key = ?
    `);

    db.transaction(() => {
      update.run(
        `## Requirements
1. Implement the task, ensuring build and tests pass
2. Before committing, use \`/code-audit\` to self-review your changes — fix any issues found
3. After passing self-review, commit your changes
4. Call \`bot_task_event\` to report \`task.completed\` (see Completion Protocol)
5. If you encounter blockers, call \`bot_task_event\` to report \`task.feedback\` (see Feedback Protocol)
6. Do not modify code unrelated to this task`,
        now,
        'orchestrator.task.requirements',
      );

      update.run(
        `## Completion Protocol
When your task is done (code implemented, /code-audit passed, committed), call \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "task.completed"
- \`payload\`: \`{ "summary": "brief description of what was done" }\`

Then **stop working**.

## Feedback Protocol
When you encounter any of these situations, call \`bot_task_event\` and **stop working**:
- **Blocked:** Technical blocker you cannot resolve. Use \`type: "blocked"\`.
- **Needs Clarification:** Ambiguous or conflicting requirements. Use \`type: "clarify"\`.
- **Scope Mismatch:** Task requires changes far beyond its description. Use \`type: "replan"\`.
- **Dependency Issue:** A completed dependency is incorrect. Use \`type: "blocked"\`.

Call \`bot_task_event\` with:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "task.feedback"
- \`payload\`:
\`\`\`json
{
  "type": "replan" | "blocked" | "clarify",
  "reason": "brief summary",
  "details": {}
}
\`\`\`

The orchestrator will detect your event automatically.`,
        now,
        'orchestrator.task.feedback_protocol',
      );

      update.run(
        `## Research Task Rules
This is a **research task**. When you finish your research:
1. You **MUST** call \`bot_task_event\` with \`event_type: "task.feedback"\` before ending
2. Use \`type: "replan"\` with your findings in \`details\`
3. Example payload:
\`\`\`json
{
  "type": "replan",
  "reason": "Research completed — findings may affect task plan",
  "details": {
    "findings": "Your research conclusions here",
    "recommendations": ["actionable suggestion 1", "suggestion 2"],
    "affectedTasks": ["t3", "t4"]
  }
}
\`\`\`
4. Do NOT write implementation code — only research, document, and report back`,
        now,
        'orchestrator.task.research_rules',
      );

      update.run(
        `You are a task replanner for a software development goal orchestrator.
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

If no changes are needed, return: { "changes": [], "reasoning": "...", "impactLevel": "low" }`,
        now,
        'orchestrator.replan',
      );
    })();
  },

  down(db) {
    const now = Date.now();

    const update = db.prepare(`
      UPDATE prompt_configs SET template = ?, updated_at = ? WHERE key = ?
    `);

    db.transaction(() => {
      update.run(
        `## Requirements
1. After implementation, run the project's build and test commands to verify correctness
2. Fix any build or test failures before committing
3. If you need user decisions or encounter blockers, write a feedback file (see Feedback Protocol)
4. Do not modify code unrelated to this task`,
        now,
        'orchestrator.task.requirements',
      );

      update.run(
        `## Feedback Protocol
When you encounter any of these situations, write a feedback file and **end your session**:
- **Blocked:** Technical blocker you cannot resolve (missing API, wrong architecture, external dependency). Use \`type: "blocked"\`.
- **Needs Clarification:** Ambiguous task or conflicting requirements. Use \`type: "clarify"\`, list questions in \`details.questions\`.
- **Scope Mismatch:** Task requires changes far beyond its description, or should be split. Use \`type: "replan"\`.
- **Dependency Issue:** A completed dependency is incorrect or insufficient. Use \`type: "blocked"\`, reference in \`details.dependencyId\`.

**File path:** \`feedback/{{TASK_ID}}.json\`
**Format:**
\`\`\`json
{
  "type": "replan" | "blocked" | "clarify",
  "reason": "brief summary",
  "details": {}
}
\`\`\`

After writing the feedback file, \`git add\` and \`git commit\` it, then **stop working**.`,
        now,
        'orchestrator.task.feedback_protocol',
      );

      update.run(
        `## Research Task Rules
This is a **research task**. When you finish your research:
1. You **MUST** write a feedback file before ending
2. Use \`type: "replan"\` with your findings in \`details\`
3. Example:
\`\`\`json
{
  "type": "replan",
  "reason": "Research completed — findings may affect task plan",
  "details": {
    "findings": "Your research conclusions here",
    "recommendations": ["actionable suggestion 1", "suggestion 2"],
    "affectedTasks": ["t3", "t4"]
  }
}
\`\`\`
4. Do NOT write implementation code — only research, document, and report back via feedback`,
        now,
        'orchestrator.task.research_rules',
      );

      update.run(
        `You are a task replanner for a software development goal orchestrator.
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
4. Dependencies must reference valid task IDs (existing or newly added)
5. Keep changes minimal — only modify what the feedback necessitates
6. Preserve the overall goal direction

## Output Format
Respond with a single JSON object (no markdown fences, no extra text):

{
  "changes": [
    { "action": "add", "task": { "id": "t8", "description": "...", "type": "代码", "depends": ["t3"], "phase": 3, "complexity": "simple" } },
    { "action": "modify", "taskId": "t5", "updates": { "description": "new desc", "depends": ["t3", "t8"], "phase": 2, "complexity": "complex" } },
    { "action": "remove", "taskId": "t7", "reason": "superseded by t8" },
    { "action": "reorder", "taskId": "t6", "newDepends": ["t8"], "newPhase": 3 }
  ],
  "reasoning": "Explanation of why these changes are needed",
  "impactLevel": "low" | "medium" | "high"
}

Impact levels (assessed by affected pending tasks):
- low: affects ≤1 pending task (description tweaks, dependency reorder)
- medium: affects 2-3 pending tasks (task additions/removals, but overall direction unchanged)
- high: affects ≥4 pending tasks, OR significant restructuring with both add+remove that changes direction
Note: low/medium changes are auto-applied; high requires user approval.

Valid task types: 代码, 手动, 调研, 占位
Task granularity: split by **feature/functionality**, NOT by technical layer. One feature = one task, even if it touches frontend + backend + API.
Valid complexity (for 代码 tasks): "simple" (straightforward logic, has patterns to follow) or "complex" (needs architecture design or cross-module coordination). Default: "simple"
Valid actions: add, modify, remove, reorder

If no changes are needed, return: { "changes": [], "reasoning": "...", "impactLevel": "low" }`,
        now,
        'orchestrator.replan',
      );
    })();
  },
};

export default migration;
