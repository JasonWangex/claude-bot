# Audit Fix Summary - Task g8t5

## 修复的问题

### 1. [error] discord/api/types.ts:81 - 移除 TaskDetail.message_history 字段

**问题：** TaskDetail 接口仍定义 message_history 字段，但后端已不再返回此字段。

**修复：**
```typescript
// Before
export interface TaskDetail extends TaskSummary {
  claude_session_id: string | null;
  plan_mode: boolean;
  message_history: Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
}

// After
export interface TaskDetail extends TaskSummary {
  claude_session_id: string | null;
  plan_mode: boolean;
}
```

### 2. [error] web/src/lib/types.ts:104 - 移除前端 TaskDetail.message_history 字段

**问题：** 前端 TaskDetail 类型仍定义 message_history 字段，与后端响应不匹配。

**修复：**
```typescript
// Before
export interface TaskDetail extends TaskSummary {
  claude_session_id: string | null;
  plan_mode: boolean;
  message_history: Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
}

// After
export interface TaskDetail extends TaskSummary {
  claude_session_id: string | null;
  plan_mode: boolean;
}
```

### 3. [error] web/src/pages/TaskDetail.tsx:71 - 移除对 task.message_history 的访问

**问题：** 前端代码仍在访问 `task.message_history.length` 和 `task.message_history`，但后端已不再返回该字段，会导致 TypeError。

**修复：**
- 移除了 `MessageHistory` 组件的 import
- 从 Tabs 中移除了"消息历史"标签页
- 保留了"交互日志"标签页（使用新的 InteractionLog 组件）

```tsx
// Before
import { MessageHistory } from '@/components/tasks/MessageHistory';
...
<Tabs items={[
  { key: 'interactions', label: '交互日志', ... },
  { key: 'messages', label: `消息历史 (${task.message_history.length})`, children: <MessageHistory messages={task.message_history} /> },
  ...
]} />

// After
<Tabs items={[
  { key: 'interactions', label: '交互日志', ... },
  // 移除了消息历史标签页
  ...
]} />
```

## 未修复的警告

按照指示，仅修复了 error 级别的问题，以下 warning 级别问题未修复：

4. [warning] discord/api/routes/sessions.ts:58 - ESM 模块中使用 require('path')
5. [warning] discord/utils/session-reader.ts:157 - readSessionEventsSync() 中动态加载 require('fs')
6. [warning] discord/utils/session-reader.ts:86 - findSessionJsonlFile() 文件名匹配逻辑

## 验证结果

- ✅ 所有修改的文件通过 `tsx --check` 语法检查
- ✅ 后端类型定义与路由响应一致
- ✅ 前端类型定义与后端响应匹配
- ✅ 前端不再访问已废弃的字段
- ⚠️  npm test 失败是因为缺少依赖包（better-sqlite3, discord.js），不是代码问题

## 影响分析

### 后端变更
- TaskDetail 接口更简洁，移除了未使用的字段
- API 响应体积减小（不再包含 message_history）

### 前端变更
- TaskDetail 页面移除了"消息历史"标签页
- 用户可以通过"交互日志"标签页查看会话数据
- 如需完整对话历史，可通过新的流式 API：`GET /api/sessions/:id/conversation`

## 建议

如果需要在前端显示完整对话历史，可以考虑：
1. 创建新的组件调用 `GET /api/sessions/:id/conversation` 流式端点
2. 实现客户端流式读取 JSONL 数据
3. 展示完整的 Claude CLI 交互事件流

但这超出了当前审计修复的范围。
