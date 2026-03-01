import type { Migration } from '../migrate.js';

/**
 * 049 — 修正 test_rules：task 应自行解决问题，而非直接 replan
 *
 * 之前 test_rules 要求测试失败时立即上报 replan，但正确逻辑是：
 * task 应先尝试自己修复（测试设计问题 → 修测试；bug 在自己分支 → 修代码），
 * 只有当 bug 在其他已合并的代码中无法在本任务内解决时，才通过 task.feedback 上报。
 * Review 阶段再做二次判断（fail / replan）。
 */

const TEST_RULES = `## Test Task Rules

This is a **测试型** task. Your responsibility: ensure the tests pass and are well-designed before completing.

### Workflow

1. Write or update the tests per the task description
2. **Run the full test suite** to verify
3. If tests fail — investigate and fix:
   - Test design problem (wrong assertions, missing setup, etc.) → fix the tests
   - Bug in code **within your branch** → fix the code
   - Bug in **already-merged code** you cannot fix here → report via \`task.feedback\` (type: \`"replan"\`) with details, then stop
4. Only call \`task.completed\` when all tests pass

The review after completion will independently verify test quality and check for bugs in merged code.`;

const migration: Migration = {
  version: 49,
  name: 'fix_test_rules_self_resolve',

  up(db) {
    const now = Date.now();
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, updated_at = ?
      WHERE key = ?
    `).run(TEST_RULES, now, 'orchestrator.task.test_rules');
  },

  down(db) {
    const now = Date.now();
    const OLD = `## Test Task Rules

This is a **测试型** task. After writing or updating tests:

1. **Run the full test suite** to verify the tests actually pass
2. **If tests fail:**
   - Do NOT mark as completed
   - Report via \`task.feedback\` with \`type: "replan"\`
   - List each failing test and the likely root cause (implementation bug vs. wrong test)
   - Suggest fix tasks for the orchestrator to create
3. **Only call \`task.completed\` when all tests pass**

Test failures are high-priority signals — they likely indicate bugs in previously merged code.`;
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, updated_at = ?
      WHERE key = ?
    `).run(OLD, now, 'orchestrator.task.test_rules');
  },
};

export default migration;
