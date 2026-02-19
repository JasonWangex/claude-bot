---
name: merge
description: >
  合并 worktree 分支到主分支并清理。检查未提交代码、合并分支、删除 worktree、
  删除 Discord Thread。合并成功后自动写入 Dev Log 到 SQLite。
disable-model-invocation: true
---

# Merge & Cleanup - 分支合并与清理

将 worktree 分支合并到 main 并清理资源。

**参数:**
- 目标 Task ID: {{TARGET_TOPIC_ID}}
- 目标分支: {{TARGET_BRANCH}}
- 工作目录: {{TARGET_CWD}}
- Main worktree: {{MAIN_CWD}}

## 第一步：执行合并与清理

**重要：用一个 bash 脚本完成全部操作，不要分步执行。** 运行以下脚本：

```bash
#!/bin/bash
set -e

TARGET_CWD="{{TARGET_CWD}}"
TARGET_BRANCH="{{TARGET_BRANCH}}"
TASK_ID="{{TARGET_TOPIC_ID}}"
MAIN_CWD="{{MAIN_CWD}}"

echo "=== Step 1: 检查工作目录 ==="
cd "$TARGET_CWD"
STATUS=$(git status --porcelain)
if [ -n "$STATUS" ]; then
  echo "发现未提交的更改，自动提交..."
  git add -A && git commit -m "auto commit before merge" || { echo "FAIL: 自动提交失败"; exit 1; }
fi
echo "工作目录干净"

echo "=== Step 2: 收集分支信息（合并前） ==="
cd "$MAIN_CWD"
COMMIT_COUNT=$(git log main.."$TARGET_BRANCH" --oneline | wc -l | tr -d ' ')
COMMIT_MESSAGES=$(git log main.."$TARGET_BRANCH" --pretty=format:"- %s")
DIFF_STAT=$(git diff --shortstat main..."$TARGET_BRANCH")
echo "DEVLOG_COMMIT_COUNT=$COMMIT_COUNT"
echo "DEVLOG_COMMIT_MESSAGES<<EOF"
echo "$COMMIT_MESSAGES"
echo "EOF"
echo "DEVLOG_DIFF_STAT=$DIFF_STAT"

echo "=== Step 3: 合并到 main ==="
git merge "$TARGET_BRANCH" --no-edit || { echo "FAIL: 合并冲突"; git merge --abort; exit 1; }
echo "合并成功"

echo "=== Step 4: 验证合并 ==="
if ! git branch --merged main | grep -q "$TARGET_BRANCH"; then
  echo "FAIL: 分支未完全合并到 main"
  exit 1
fi
echo "分支已完全合并"

echo "=== Step 5: 删除 worktree ==="
git worktree remove "$TARGET_CWD" || { echo "FAIL: 删除 worktree 失败"; exit 1; }
echo "Worktree 已删除"

echo "=== Step 6: 删除分支 ==="
git branch -d "$TARGET_BRANCH" || { echo "FAIL: 删除分支失败（可能未完全合并）"; exit 1; }
echo "分支已删除"

echo "=== Step 7: 删除 Discord Thread ==="
RESP=$(curl -sf --connect-timeout 3 --max-time 10 -X DELETE "http://127.0.0.1:3456/api/tasks/$TASK_ID" 2>/dev/null) \
  && echo "API 响应: $RESP" \
  || echo "删除 Thread 跳过（API 不可用或 Thread 不存在）"

echo ""
echo "===== 完成 ====="
echo "合并清理完成"
echo "- 分支: $TARGET_BRANCH → main"
echo "- Worktree: 已删除"
echo "- 分支: 已删除"
echo "- Discord Thread: 已归档"
```

## 第二步：写入 Dev Log

**脚本成功后，必须执行此步骤。** 使用 `/devlog` skill 将合并记录写入 SQLite。脚本输出中的 `DEVLOG_` 开头的信息会被 devlog skill 自动识别使用。

## 第三步：标记关联 Idea 为 Done

**devlog 写入成功后，执行此步骤。**

查询 Processing 状态的 Ideas：

```
bot_list_ideas(project="<项目名>", status="Processing")
```

如果找到匹配的记录（根据分支名或任务描述判断关联性），更新其状态为 Done：

```
bot_update_idea(idea_id="<id>", status="Done")
```

如果没找到 Processing 状态的 Idea，跳过此步骤。

## 安全规则

- 使用 `git branch -d`（安全删除），禁止 `-D`
- 合并冲突时中止并报告，不强制合并
- 合并在 main worktree 中执行，不在被删除的 worktree 中操作

**立即运行上面的脚本，不要拆分成多个命令。如果脚本失败，报告具体的 FAIL 原因，不执行第二步。**
