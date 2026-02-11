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

### Step 2: 代码审查

对所有变更进行审查，关注以下方面：

- **正确性**：逻辑错误、边界条件、空值处理
- **安全性**：注入漏洞、敏感信息泄露、OWASP Top 10
- **一致性**：与项目现有代码风格和模式是否一致
- **明显遗漏**：debug 代码残留、TODO/FIXME、未完成的实现

严重程度分级：
- 🔴 **CRITICAL** — 必须修复，阻止提交
- 🟠 **HIGH** — 强烈建议修复后再提交
- 🟡 **MEDIUM** — 建议修复，但不阻止提交
- 🔵 **LOW** — 可选优化，不阻止提交

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
- 如果有 `{{SKILL_ARGS}}`，将其作为 commit message 的参考或直接使用
