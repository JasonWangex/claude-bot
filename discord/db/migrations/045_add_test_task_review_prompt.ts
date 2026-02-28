import type { Migration } from '../migrate.js';

const TEMPLATE = `## Review Test Task: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Branch:** \`{{BRANCH_NAME}}\`
\`\`\`
{{DIFF_STATS}}
\`\`\`

This is a **测试型** (test) task. Do NOT run \`/code-audit\`. Instead, review whether the testing approach is correct:

1. **Test coverage** — Do the tests actually verify what the description intends?
2. **Test correctness** — Are assertions meaningful? Do they catch real failures?
3. **Test completeness** — Are important edge cases and error paths covered?
4. **Test quality** — Are tests isolated, deterministic, and not testing implementation details?

If the testing approach is flawed or incomplete, describe the specific issues so the implementer can fix them.

Report result via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`: \`{ "verdict": "pass"|"fail", "summary": "...", "issues": [] }\``;

const migration: Migration = {
  version: 45,
  name: 'add_test_task_review_prompt',

  up(db) {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO prompt_configs
        (key, category, name, description, template, variables, parent_key, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(
      'orchestrator.test_task_review',
      'orchestrator',
      '测试任务审核',
      '测试型任务专用 review prompt，只验证测试思路是否正确，不运行 code-audit',
      TEMPLATE,
      JSON.stringify(['TASK_LABEL', 'TASK_DESCRIPTION', 'BRANCH_NAME', 'DIFF_STATS', 'TASK_ID']),
      now,
      now,
    );

    // 同步更新 replan prompt 中的 valid task types，使 Tech Lead 知道可以创建测试型任务
    db.prepare(`
      UPDATE prompt_configs
      SET template = REPLACE(template, 'Valid task types: 代码, 手动, 调研, 占位', 'Valid task types: 代码, 手动, 调研, 占位, 测试'),
          updated_at = ?
      WHERE key = 'orchestrator.replan'
        AND template LIKE '%Valid task types: 代码, 手动, 调研, 占位%'
    `).run(now);
  },

  down(db) {
    db.prepare(`DELETE FROM prompt_configs WHERE key = ?`).run('orchestrator.test_task_review');
    // 回滚 replan prompt 中的 valid task types
    db.prepare(`
      UPDATE prompt_configs
      SET template = REPLACE(template, 'Valid task types: 代码, 手动, 调研, 占位, 测试', 'Valid task types: 代码, 手动, 调研, 占位'),
          updated_at = ?
      WHERE key = 'orchestrator.replan'
        AND template LIKE '%Valid task types: 代码, 手动, 调研, 占位, 测试%'
    `).run(Date.now());
  },
};

export default migration;
