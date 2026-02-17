#!/usr/bin/env node
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

const db = new Database('data/bot.db');

const entry = {
  id: randomUUID(),
  title: 'Claude Session 状态管理与 Goal Task 自动检查机制',
  content: `# Session 状态管理

## 状态定义
- **active**: Claude 正在执行（SessionStart）
- **waiting**: 等待用户输入（Notification）
- **idle**: 当前轮次完成（Stop）
- **closed**: session 已结束（SessionEnd）

## Hook 事件处理

**SessionStart**: \`status = 'active'\`

**Notification**:
- \`status = 'waiting'\`
- 延迟 5 秒发送等待消息（用户交互时可取消）

**Stop**:
- \`status = 'idle'\`
- 10 秒幂等窗口防止重复 Done 消息（通过 \`last_stop_at\` 字段持久化）
- 触发 Goal task 自动检查

**SessionEnd**:
- \`status = 'closed'\`
- 异常退出时标记 running task 为 failed

## 关键机制

**等待消息**:
- 延迟 5 秒避免闪烁
- 用户交互时自动取消（\`StateManager.cancelWaitingMessage()\`）
- 双重检查机制：检查定时器是否被取消 + 检查 session 状态

**超时监控**:
- SessionTimeoutService 每 5 分钟检查
- 30 分钟无活动的 session 自动关闭

**并发保护**:
- Session 级别的锁（\`sessionLocks\` Map）
- 防止并发 Hook 事件导致状态覆盖

---

# Goal Task 自动检查（3 问）

## 触发条件
Stop hook + task.status='running' + task.goalId 存在

## 检查问题

**Execute 阶段**:
1. 任务是否完成？
2. 自我审查是否通过？
3. 代码是否已提交？

**Audit 阶段**:
1. 所有 audit 建议都已修复？
2. 代码已更新并提交？
3. 是否准备好 merge？

## 自动推进规则

**全部 yes**:
- Execute → Audit (complex) 或 Completed (simple)
- Audit → Completed

**有 no**:
- 记录到 \`task.metadata.lastCheckIssues\`
- Claude 继续工作

## 回答解析

优先级：
1. Feedback 文件: \`feedback/{taskId}-readiness.json\`
2. Discord 消息: 解析最后一条 bot 消息的 yes/no

---

# 启用配置

\`\`\`bash
# .env
CLAUDE_HOOK_ENABLED=true

# 插入 prompt 模板
./scripts/seed-prompts.sh

# 启动超时监控
timeoutService.start()
\`\`\`

---

# 数据库 Schema

\`\`\`sql
-- 新增字段
ALTER TABLE claude_sessions ADD COLUMN last_activity_at INTEGER;
ALTER TABLE claude_sessions ADD COLUMN last_usage_json TEXT;
ALTER TABLE claude_sessions ADD COLUMN last_stop_at INTEGER;  -- 幂等窗口持久化

-- 索引
CREATE INDEX idx_claude_sessions_status_activity
  ON claude_sessions(status, last_activity_at);
\`\`\`

---

# 监控

\`\`\`sql
-- 查看 session 状态
SELECT id, status, datetime(last_activity_at/1000, 'unixepoch')
FROM claude_sessions ORDER BY created_at DESC LIMIT 10;
\`\`\`

\`\`\`bash
# 日志监控
tail -f logs/discord-bot.log | grep -E "\\[Hook\\]|checkTaskReadiness"
\`\`\`

---

# 改进点

1. **幂等窗口持久化**：\`last_stop_at\` 存储在数据库中，服务器重启后仍然有效
2. **并发保护**：Session 级别锁防止并发 Hook 事件冲突
3. **双重检查**：等待消息发送前检查定时器和状态，避免竞态条件
4. **性能优化**：每次 Hook 处理 < 10ms（1 次 DB 读 + 1 次 DB 写）`,
  category: 'Architecture',
  tags: JSON.stringify(['session-management', 'hooks', 'goal-orchestrator', 'automation', 'pipeline']),
  project: 'claude-bot',
  source: 'Goal: Session 状态管理与生命周期优化',
  created_at: Date.now(),
  updated_at: Date.now(),
};

const stmt = db.prepare(`
  INSERT INTO knowledge_base (
    id, title, content, category, tags, project, source, created_at, updated_at
  ) VALUES (
    @id, @title, @content, @category, @tags, @project, @source, @created_at, @updated_at
  )
`);

stmt.run(entry);

console.log('✅ 知识库条目已添加');
console.log('ID:', entry.id);
console.log('标题:', entry.title);
console.log('分类:', entry.category);

db.close();
