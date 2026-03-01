import type { Migration } from '../migrate.js';

/**
 * 048 — 测试 review 三级 verdict 区分
 *
 * 原来只有 pass/fail。现在拆分为：
 * - pass   — 测试通过 & 设计合理
 * - fail   — 测试方法/设计有问题（让测试任务自己修）
 * - replan — 测试通过但发现实现 bug（合并测试分支，触发修复 replan）
 */

const TEST_TASK_REVIEW = `## Review Test Task: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Branch:** \`{{BRANCH_NAME}}\`
\`\`\`
{{DIFF_STATS}}
\`\`\`

This is a **测试型** (test) task. Do NOT run \`/code-audit\`.

---

### Step 1 — Run the tests

Actually execute the test suite now:
\`\`\`
pnpm test   # or the project's test command
\`\`\`

Record: did all tests pass or fail? Which ones failed and why?

---

### Step 2 — Evaluate test design

Even if tests pass, assess the design:

1. **Reasonableness** — Is the approach appropriate? Are tests testing the right behaviour, not just structure?
2. **Correctness** — Are assertions meaningful? Would they catch real regressions?
3. **Coverage** — Are important edge cases, error paths, and boundaries covered?
4. **Isolation** — Are tests deterministic and independent?

Key question: could a buggy implementation slip past these tests?

---

### Verdict — choose exactly one:

| Verdict | When to use |
|---------|-------------|
| \`pass\` | Tests pass **and** design is sound |
| \`fail\` | Test design has significant problems (wrong approach, weak assertions, missing coverage) — the test author should fix their tests |
| \`replan\` | Tests are well-designed **but** they reveal a bug in existing implementation — merge the test branch and create fix tasks |

> **Key distinction:** \`fail\` = the tests themselves are wrong; \`replan\` = the tests are correct and expose a real bug.

---

Report result via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`:
\`\`\`json
{
  "verdict": "pass" | "fail" | "replan",
  "summary": "brief overall conclusion",
  "issues": [
    "Specific issue or failing test with details"
  ]
}
\`\`\``;

const migration: Migration = {
  version: 48,
  name: 'test_review_three_verdicts',

  up(db) {
    const now = Date.now();
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, updated_at = ?
      WHERE key = ?
    `).run(TEST_TASK_REVIEW, now, 'orchestrator.test_task_review');
  },

  down(db) {
    const now = Date.now();
    // 回滚到 047 版本的 prompt（两步 review，但只有 pass/fail）
    const PREV = `## Review Test Task: {{TASK_LABEL}}
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
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, updated_at = ?
      WHERE key = ?
    `).run(PREV, now, 'orchestrator.test_task_review');
  },
};

export default migration;
