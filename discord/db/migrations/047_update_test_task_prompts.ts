import type { Migration } from '../migrate.js';

/**
 * 047 — 更新测试任务 prompts
 *
 * 1. 更新 orchestrator.test_task_review：
 *    - 要求 reviewer 实际运行测试，判断测试是否通过
 *    - 测试不通过 → verdict: 'fail'，上报为潜在 bug
 *    - 重点审查测试设计是否合理，而非代码质量
 *
 * 2. 新增 orchestrator.task.test_rules：
 *    - 注入到测试型任务的 prompt 中
 *    - 要求任务执行后运行测试套件
 *    - 测试失败 → task.feedback (type='replan')，列出失败详情
 *    - 全部通过才能 task.completed
 */

const TEST_TASK_REVIEW = `## Review Test Task: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Branch:** \`{{BRANCH_NAME}}\`
\`\`\`
{{DIFF_STATS}}
\`\`\`

This is a **测试型** (test) task. Do NOT run \`/code-audit\`. Your job has two parts:

---

### Part 1 — Run the tests

Actually run the test suite to see if the tests pass right now:
\`\`\`
pnpm test   # or the project's test command
\`\`\`

If tests **fail**: this is a **bug signal**, not just a review issue. The failure details go into \`issues\` and verdict must be \`fail\`.

---

### Part 2 — Review test design

Even if tests pass, evaluate whether the design is sound:

1. **Reasonableness** — Is the testing approach appropriate for the task goal? Are tests testing the right thing, not just passing trivially?
2. **Correctness** — Are assertions meaningful? Would tests actually catch real regressions?
3. **Coverage** — Are important edge cases, error paths, and boundaries covered?
4. **Isolation** — Are tests deterministic and independent of each other?

**Key question:** Could a buggy implementation slip past these tests?

---

### Verdict

- \`pass\` — Tests pass AND design is sound
- \`fail\` — Tests fail (bug risk) OR design has significant gaps

Report result via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`:
\`\`\`json
{
  "verdict": "pass" | "fail",
  "summary": "brief overall conclusion",
  "issues": [
    "Test X failed: <error message> — possible bug in <module>",
    "Missing coverage for <scenario>"
  ]
}
\`\`\``;

const TEST_RULES = `## Test Task Rules

This is a **测试型** task. After writing or updating tests:

1. **Run the full test suite** to verify the tests actually pass
2. **If tests fail:**
   - Do NOT mark as completed
   - Report via \`task.feedback\` with \`type: "replan"\`
   - List each failing test and the likely root cause (implementation bug vs. wrong test)
   - Suggest fix tasks for the orchestrator to create
3. **Only call \`task.completed\` when all tests pass**

Test failures are high-priority signals — they likely indicate bugs in previously merged code.`;

const migration: Migration = {
  version: 47,
  name: 'update_test_task_prompts',

  up(db) {
    const now = Date.now();

    // 1. 更新 test_task_review prompt
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, updated_at = ?
      WHERE key = ?
    `).run(TEST_TASK_REVIEW, now, 'orchestrator.test_task_review');

    // 2. 新增 test_rules prompt（注入到测试型任务执行 prompt 中）
    db.prepare(`
      INSERT OR IGNORE INTO prompt_configs
        (key, category, name, description, template, variables, parent_key, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      'orchestrator.task.test_rules',
      'orchestrator',
      '测试任务规则',
      '注入到测试型任务中，要求执行后运行测试并对失败上报 replan',
      TEST_RULES,
      JSON.stringify([]),
      'orchestrator.task',
      now,
      now,
    );
  },

  down(db) {
    const now = Date.now();

    // 回滚 test_task_review 到旧版本
    const OLD_REVIEW = `## Review Test Task: {{TASK_LABEL}}
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

    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, updated_at = ?
      WHERE key = ?
    `).run(OLD_REVIEW, now, 'orchestrator.test_task_review');

    db.prepare(`DELETE FROM prompt_configs WHERE key = ?`).run('orchestrator.task.test_rules');
  },
};

export default migration;
