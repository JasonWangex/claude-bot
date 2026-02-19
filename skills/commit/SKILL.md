---
name: commit
description: >
  Review code changes and commit. Triggers: "commit", "/commit".
  First performs a code review on staged/unstaged changes, then commits
  if no issues are found.
---

# Commit Skill

审查当前代码变更，确认无问题后自动提交。

## Workflow

### Step 1: 检查变更状态

运行 `git status` 和 `git diff`（含 staged 和 unstaged），了解所有待提交的变更。

如果没有任何变更，告知用户并结束。

### Step 2: 代码审查（使用 /code-audit）

调用 `/code-audit` skill 对**本次变更涉及的文件**进行审计。

**审计范围限定**：仅审计 diff 中涉及的文件，不是整个项目。将变更文件列表和 diff 内容作为上下文提供给 code-audit，让其聚焦于变更部分执行 4 阶段审计：
1. 代码质量 — 变更代码的复杂度、类型安全、错误处理
2. 数据流转 — 变更是否破坏了现有数据流
3. 前后端交互 — 变更涉及的 API 契约是否一致
4. 逻辑异常处理 — 变更中的错误路径是否完整

> 注意：对于小幅变更（<5 个文件且 diff <100 行），可简化为仅执行 Phase 1 和 Phase 4。

### Step 3: 根据审查结果决定下一步

**如果存在 🔴 CRITICAL 或 🟠 HIGH 问题：**
- 列出所有发现的问题及修复建议
- 询问用户是否要先修复这些问题
- 不自动提交

**如果只有 🟡 MEDIUM 或 🔵 LOW 问题，或无问题：**
- 简要报告审查结果（如有 MEDIUM/LOW 问题则列出）
- 将所有变更暂存（`git add` 相关文件）
- 基于变更内容生成 commit message
- 执行 `git commit`

### Step 4: 回复结果

提交完成后（无论是成功提交还是因问题阻止），在最后附上当前分支名：

```
📌 当前分支: <branch-name>
```

### Commit Message 规范

遵循 Conventional Commits 格式：

```
type(scope): 简短描述

可选的详细说明
```

- 根据 `git log` 的历史风格来匹配项目惯例
- 描述「为什么」改而不只是「改了什么」
- 如果有 `$ARGUMENTS`，将其作为 commit message 的参考或直接使用
