import type { Migration } from '../migrate.js';
import { seedPromptConfigs } from '../seeds/prompt-seeds.js';

/**
 * Migration 011: Prompt 库优化
 *
 * 1. UPDATE 已有 prompt 模板（重写 task/plan/execute/audit/fix/self_review 相关模板）
 * 2. DELETE 被合并的 prompt（when_to_feedback, verify_section, verify_fallback, critical_rules）
 * 3. INSERT 新增 prompt（fix.verify, task_readiness_check.execute, task_readiness_check.audit）
 *    — 通过 seedPromptConfigs 的 INSERT OR IGNORE 实现
 */

// 统一的 detail_plan NOTE 措辞
const DETAIL_PLAN_NOTE = `**NOTE**: This detailed plan is from the goal planning phase. Follow it where applicable, but adapt to actual codebase constraints.`;

const migration: Migration = {
  version: 11,
  name: 'update_prompts',

  up(db) {
    const now = Date.now();

    const update = db.prepare(`
      UPDATE prompt_configs SET template = ?, variables = ?, description = ?, updated_at = ?
      WHERE key = ?
    `);

    db.transaction(() => {
      // ================================================================
      // 1. UPDATE 已有 prompt
      // ================================================================

      // --- orchestrator.task 主模板：添加 git worktree 环境说明 ---
      update.run(
        `You are a subtask executor for Goal "{{GOAL_NAME}}".

## Environment
- You are working in a **git worktree** dedicated to this task
- Commit with descriptive messages: \`<type>(<scope>): <summary>\` (e.g. \`feat(auth): add login endpoint\`, \`fix(db): handle null input\`)

## Current Task
ID: {{TASK_LABEL}}
Type: {{TASK_TYPE}}
Description: {{TASK_DESCRIPTION}}`,
        JSON.stringify(['GOAL_NAME', 'TASK_LABEL', 'TASK_TYPE', 'TASK_DESCRIPTION']),
        '简单代码任务的直接执行（无 plan 阶段）',
        now,
        'orchestrator.task',
      );

      // --- orchestrator.task.detail_plan：统一 NOTE ---
      update.run(
        `{{DETAIL_PLAN_TEXT}}

${DETAIL_PLAN_NOTE}`,
        JSON.stringify(['DETAIL_PLAN_TEXT']),
        '注入来自 Goal body 的详细计划',
        now,
        'orchestrator.task.detail_plan',
      );

      // --- orchestrator.task.requirements：重写 ---
      update.run(
        `## Requirements
1. After implementation, run the project's build and test commands to verify correctness
2. Fix any build or test failures before committing
3. If you need user decisions or encounter blockers, write a feedback file (see Feedback Protocol)
4. Do not modify code unrelated to this task`,
        JSON.stringify([]),
        '任务执行的通用要求',
        now,
        'orchestrator.task.requirements',
      );

      // --- orchestrator.task.feedback_protocol：合并 when_to_feedback ---
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
        JSON.stringify(['TASK_ID']),
        '任务遇到问题时的反馈机制（含触发场景）',
        now,
        'orchestrator.task.feedback_protocol',
      );

      // --- orchestrator.plan 主模板：添加 git worktree 环境说明 ---
      update.run(
        `You are a senior architect planning a subtask implementation for Goal "{{GOAL_NAME}}".

## Environment
- You are working in a **git worktree** dedicated to this task

## Task to Plan
ID: {{TASK_LABEL}}
Description: {{TASK_DESCRIPTION}}`,
        JSON.stringify(['GOAL_NAME', 'TASK_LABEL', 'TASK_DESCRIPTION']),
        '高级架构师规划子任务实现（复杂代码）',
        now,
        'orchestrator.plan',
      );

      // --- orchestrator.plan.detail_plan：统一 NOTE ---
      update.run(
        `{{DETAIL_PLAN_TEXT}}

${DETAIL_PLAN_NOTE}`,
        JSON.stringify(['DETAIL_PLAN_TEXT']),
        '注入来自 Goal body 的设计意图',
        now,
        'orchestrator.plan.detail_plan',
      );

      // --- orchestrator.plan.instructions：简化，移除死板模板 ---
      update.run(
        `## Your Job
Analyze the codebase and write a detailed implementation plan to \`.task-plan.md\`.

The plan should cover:
- Which files need to be modified or created, and why
- Step-by-step implementation approach with specific details
- Key design decisions and rationale
- Edge cases and risks

## Rules
- Do NOT write implementation code — only the plan
- The plan must be specific enough for a different developer to implement without ambiguity
- After writing: \`git add .task-plan.md && git commit -m "plan: {{TASK_LABEL}} implementation plan"\`
- Then STOP`,
        JSON.stringify(['TASK_LABEL']),
        '计划阶段的具体指令',
        now,
        'orchestrator.plan.instructions',
      );

      // --- orchestrator.execute_with_plan 主模板：添加环境说明 ---
      update.run(
        `You are implementing a subtask for Goal "{{GOAL_NAME}}".
A senior architect has already created a detailed plan for you.

## Environment
- You are working in a **git worktree** dedicated to this task
- Commit with descriptive messages: \`<type>(<scope>): <summary>\`

## Current Task
ID: {{TASK_LABEL}}
Description: {{TASK_DESCRIPTION}}`,
        JSON.stringify(['GOAL_NAME', 'TASK_LABEL', 'TASK_DESCRIPTION']),
        '按计划实施代码（复杂代码）',
        now,
        'orchestrator.execute_with_plan',
      );

      // --- orchestrator.execute_with_plan.detail_plan：统一 NOTE ---
      update.run(
        `{{DETAIL_PLAN_TEXT}}

${DETAIL_PLAN_NOTE} However, **your primary guide is the .task-plan.md file** created by the architect.`,
        JSON.stringify(['DETAIL_PLAN_TEXT']),
        '执行阶段的设计意图参考',
        now,
        'orchestrator.execute_with_plan.detail_plan',
      );

      // --- orchestrator.execute_with_plan.instructions：简化 ---
      update.run(
        `## Instructions
1. Read the plan: \`cat .task-plan.md\`
2. Implement each step in order
3. Run the project's build and test commands — fix any failures
4. Commit when build and tests pass
5. If blocked, write \`feedback/{{TASK_ID}}.json\` with \`{"type": "blocked", "reason": "..."}\`, commit, and stop

## Rules
- Follow the plan — do not add features not in the plan
- Do not modify files not mentioned unless absolutely necessary`,
        JSON.stringify(['TASK_ID']),
        '执行阶段的具体指令',
        now,
        'orchestrator.execute_with_plan.instructions',
      );

      // --- orchestrator.audit.detail_plan：统一 NOTE ---
      update.run(
        `{{DETAIL_PLAN_TEXT}}

${DETAIL_PLAN_NOTE}`,
        JSON.stringify(['DETAIL_PLAN_TEXT']),
        '审查阶段的设计意图基准',
        now,
        'orchestrator.audit.detail_plan',
      );

      // --- orchestrator.audit.instructions：简化 build 检测 ---
      update.run(
        `## Instructions
1. Run \`git log --oneline\` to see commits, then \`git diff {{GOAL_BRANCH}}...HEAD\` to see all changes
2. **Verify build and tests pass**:
   - Detect the project's build system and run the appropriate build and test commands
   - Build/test failures are **always "error" severity**
   - If no build/test config found, note it and proceed with code review only
3. Review changes for:
   - **Correctness**: Does the code fulfill the task description?
   - **Completeness**: Are all aspects addressed?
   - **Bugs**: Obvious bugs, edge cases, runtime errors?
   - **Security**: Injection, XSS, etc.?
4. Write verdict to \`feedback/{{TASK_ID}}-audit.json\`
5. \`git add feedback/{{TASK_ID}}-audit.json && git commit -m "audit: {{TASK_LABEL}}"\`

## Verdict File Format (feedback/{{TASK_ID}}-audit.json)
\`\`\`json
{
  "verdict": "pass" | "fail",
  "summary": "Brief overall assessment",
  "verifyCommands": ["the build command you ran", "the test command you ran"],
  "issues": [
    {
      "severity": "error" | "warning",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "What's wrong and why"
    }
  ]
}
\`\`\`

**IMPORTANT**: The \`verifyCommands\` array must list the exact build/test commands you ran. These will be passed to the fixer so they can re-verify after applying fixes.

## Verdict Rules
- **pass**: No "error" severity issues. Warnings are acceptable.
- **fail**: At least one "error" severity issue found.
- Build failures and test failures are ALWAYS "error" severity
- Be pragmatic — minor style issues are "warning", not "error"
- Focus on functional correctness, not code style preferences
- If no code changes are found (empty diff), verdict is "pass"`,
        JSON.stringify(['GOAL_BRANCH', 'TASK_ID', 'TASK_LABEL']),
        '审查阶段的具体指令和输出格式',
        now,
        'orchestrator.audit.instructions',
      );

      // --- orchestrator.fix 主模板：添加环境说明 ---
      update.run(
        `You are fixing audit issues found in a code review for Goal "{{GOAL_NAME}}".

## Environment
- You are working in a **git worktree** dedicated to this task

## Task
ID: {{TASK_LABEL}}
Description: {{TASK_DESCRIPTION}}`,
        JSON.stringify(['GOAL_NAME', 'TASK_LABEL', 'TASK_DESCRIPTION']),
        '修复审查发现的问题',
        now,
        'orchestrator.fix',
      );

      // --- orchestrator.fix.detail_plan：统一 NOTE ---
      update.run(
        `{{DETAIL_PLAN_TEXT}}

${DETAIL_PLAN_NOTE}`,
        JSON.stringify(['DETAIL_PLAN_TEXT']),
        '修复阶段的设计意图参考',
        now,
        'orchestrator.fix.detail_plan',
      );

      // --- orchestrator.self_review：允许修复小问题 ---
      update.run(
        `You just finished fixing audit issues. Perform a **self-review** before the senior reviewer checks again.

## Task
ID: {{TASK_LABEL}}
Description: {{TASK_DESCRIPTION}}

## Issues You Fixed
{{ISSUE_LIST}}

## Instructions
1. Read your changes (\`git diff HEAD~1\`)
2. Verify each original issue is actually fixed
{{VERIFY_COMMANDS_SECTION}}
4. If you spot small remaining problems (typos, missing imports, logic errors), **fix them now** and commit
5. Write self-review result to \`feedback/{{TASK_ID}}-self-review.json\`:
\`\`\`json
{ "allIssuesFixed": true|false, "remainingIssues": [...], "notes": "..." }
\`\`\`
6. Commit: \`git add feedback/{{TASK_ID}}-self-review.json && git commit -m "self-review: {{TASK_LABEL}}"\`

## Rules
- Be **honest** — better to catch issues now than fail the audit again
- If verify commands fail, set \`allIssuesFixed: false\`
- Fix small issues directly; only report issues you truly cannot resolve`,
        JSON.stringify(['TASK_LABEL', 'TASK_DESCRIPTION', 'ISSUE_LIST', 'VERIFY_COMMANDS_SECTION', 'TASK_ID']),
        'Fix 阶段后的自查机制（可修复小问题）',
        now,
        'orchestrator.self_review',
      );

      // ================================================================
      // 2. DELETE 被合并的 prompt
      // ================================================================
      const del = db.prepare('DELETE FROM prompt_configs WHERE key = ?');
      del.run('orchestrator.task.when_to_feedback');
      del.run('orchestrator.fix.verify_section');
      del.run('orchestrator.fix.verify_fallback');
      del.run('orchestrator.fix.critical_rules');

      // ================================================================
      // 3. INSERT 新增 prompt（通过 seedPromptConfigs）
      //    fix.verify + task_readiness_check.execute + task_readiness_check.audit
      // ================================================================
    })();

    // seed 会 INSERT OR IGNORE，只插入不存在的 key
    seedPromptConfigs(db);
  },

  down(db) {
    // Rollback: 恢复被删除的 prompt，移除新增的 prompt
    // 由于 seed 中已不包含旧模板，down 只做简单清理
    const del = db.prepare('DELETE FROM prompt_configs WHERE key = ?');
    del.run('orchestrator.fix.verify');
    del.run('orchestrator.task_readiness_check.execute');
    del.run('orchestrator.task_readiness_check.audit');

    // 注意：被 UPDATE 的模板无法自动恢复旧内容
    // 如需完整回滚，需从 git history 手动恢复 seed 后重新 seed
  },
};

export default migration;
