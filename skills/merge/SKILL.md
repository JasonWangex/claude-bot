---
name: merge
description: >
  合并 worktree 分支到主分支并清理。检查未提交代码、合并分支、删除 worktree、
  删除 Telegram topic。遵循安全规则：只有在工作目录干净且分支已完全合并后才删除。
version: 1.1.0
---

# Merge & Cleanup - 分支合并与清理

将 worktree 分支合并到 main 并清理资源。

**参数:**
- 目标 Topic ID: {{TARGET_TOPIC_ID}}
- 目标分支: {{TARGET_BRANCH}}
- 工作目录: {{TARGET_CWD}}
- Main worktree: {{MAIN_CWD}}

## 执行方式

**重要：用一个 bash 脚本完成全部操作，不要分步执行。** 运行以下脚本：

```bash
#!/bin/bash
set -e

TARGET_CWD="{{TARGET_CWD}}"
TARGET_BRANCH="{{TARGET_BRANCH}}"
TOPIC_ID="{{TARGET_TOPIC_ID}}"
MAIN_CWD="{{MAIN_CWD}}"

echo "=== Step 1: 检查工作目录 ==="
cd "$TARGET_CWD"
STATUS=$(git status --porcelain)
if [ -n "$STATUS" ]; then
  echo "发现未提交的更改，自动提交..."
  git add -A && git commit -m "auto commit before merge" || { echo "FAIL: 自动提交失败"; exit 1; }
fi
echo "工作目录干净"

echo "=== Step 2: 合并到 main ==="
cd "$MAIN_CWD"
git merge "$TARGET_BRANCH" --no-edit || { echo "FAIL: 合并冲突"; git merge --abort; exit 1; }
echo "合并成功"

echo "=== Step 3: 验证合并 ==="
if ! git branch --merged main | grep -q "$TARGET_BRANCH"; then
  echo "FAIL: 分支未完全合并到 main"
  exit 1
fi
echo "分支已完全合并"

echo "=== Step 4: 删除 worktree ==="
git worktree remove "$TARGET_CWD" || { echo "FAIL: 删除 worktree 失败"; exit 1; }
echo "Worktree 已删除"

echo "=== Step 5: 删除分支 ==="
git branch -d "$TARGET_BRANCH" || { echo "FAIL: 删除分支失败（可能未完全合并）"; exit 1; }
echo "分支已删除"

echo "=== Step 6: 删除 Telegram Topic ==="
RESP=$(curl -s -X DELETE "http://127.0.0.1:3456/api/topics/$TOPIC_ID")
echo "API 响应: $RESP"

echo ""
echo "===== 完成 ====="
echo "✅ 合并清理完成"
echo "- 分支: $TARGET_BRANCH → main"
echo "- Worktree: 已删除"
echo "- 分支: 已删除"
echo "- Telegram Topic: 已删除"
```

## 安全规则

- 使用 `git branch -d`（安全删除），禁止 `-D`
- 合并冲突时中止并报告，不强制合并
- 合并在 main worktree 中执行，不在被删除的 worktree 中操作

**立即运行上面的脚本，不要拆分成多个命令。如果脚本失败，报告具体的 FAIL 原因。**
