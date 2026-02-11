---
name: merge
description: >
  合并 worktree 分支到主分支并清理。检查未提交代码、合并分支、删除 worktree、
  删除 Telegram topic。遵循安全规则：只有在工作目录干净且分支已完全合并后才删除。
version: 1.0.0
---

# Merge & Cleanup - 分支合并与清理

自动化合并 worktree 分支到 main 并清理相关资源（worktree、分支、Telegram topic）。

**目标 Topic ID**: {{TARGET_TOPIC_ID}}
**目标分支**: {{TARGET_BRANCH}}
**工作目录**: {{TARGET_CWD}}

## 安全规则（必须严格遵守）

删除分支或 worktree 之前**必须确认以下两点，缺一不可**：
1. Worktree 工作目录干净（无未提交的修改）
2. 分支的所有 commit 已合并到 main

**如果有未合并的 commit，必须停下来报告用户，禁止自动清理。**

## 执行流程

### 步骤 1: 检查工作目录状态

```bash
cd "{{TARGET_CWD}}" && git status --porcelain
```

**判断**:
- 如果有输出（存在未提交的更改），自动提交：
  ```bash
  cd "{{TARGET_CWD}}" && git add -A && git commit -m "auto commit before merge"
  ```
- 如果提交失败，**中止流程**，输出报告

### 步骤 2: 查找 main 分支所在的 worktree

```bash
cd "{{TARGET_CWD}}" && git worktree list
```

从输出中找到包含 `[main]` 或 `[master]` 的行，提取其路径作为 `MAIN_CWD`。

### 步骤 3: 在 main worktree 中合并分支

```bash
cd "$MAIN_CWD" && git merge "{{TARGET_BRANCH}}" --no-edit
```

**判断**:
- 如果合并失败（冲突）:
  - 中止合并: `cd "$MAIN_CWD" && git merge --abort`
  - **中止流程**，输出报告告知用户存在冲突，需要手动解决

### 步骤 4: 验证分支已完全合并

```bash
cd "$MAIN_CWD" && git branch --merged main | grep "{{TARGET_BRANCH}}"
```

**判断**:
- 如果没有找到（分支未完全合并）:
  - **中止流程**，输出报告

### 步骤 5: 删除 worktree

```bash
cd "$MAIN_CWD" && git worktree remove "{{TARGET_CWD}}"
```

如果失败，报告错误并中止。

### 步骤 6: 删除分支

```bash
cd "$MAIN_CWD" && git branch -d "{{TARGET_BRANCH}}"
```

**注意**: 使用 `-d`（安全删除），禁止使用 `-D`（强制删除）。

### 步骤 7: 通过 API 删除 Telegram Topic

```bash
curl -s -X DELETE "http://127.0.0.1:3456/api/topics/{{TARGET_TOPIC_ID}}"
```

检查响应中的 `ok` 字段，如果失败则报告（但 git 清理已完成）。

### 步骤 8: 输出最终报告

成功时:
```
✅ 合并清理完成

📋 操作摘要
- 分支: {{TARGET_BRANCH}} → main
- Worktree: 已删除
- 分支: 已删除
- Telegram Topic: 已删除
```

失败时输出具体的失败原因和已完成的步骤。

## 重要提示

- **遵循安全规则**: 未合并的内容必须报告用户，不自动丢弃
- **合并在 main worktree 中执行**: 不在被删除的 worktree 中操作
- **API 调用最后执行**: 确保 git 清理完成后再删除 topic
- **禁止危险命令**: 不使用 `git branch -D`、`git clean -f`、`git checkout .` 等

---

**现在请立即执行上述流程。**
