# Claude Web 项目初始化报告

生成时间: 2026-02-09

## 项目概述

**项目名称**: claude-web
**项目位置**: `/home/jason/projects/claude-web`
**项目类型**: 基于浏览器的终端 + Telegram Bot
**主要功能**: 通过 Web 界面和 Telegram 与 Claude Code CLI 进行交互

## 技术栈

### 前端
- **框架**: React 19 + Vite 7
- **语言**: TypeScript 5.9
- **终端**: xterm.js 6.0
- **通信**: WebSocket
- **构建**: Vite (HMR 开发环境)

### 后端
- **运行时**: Node.js 18+ (ESM 模式)
- **框架**: Express 5
- **WebSocket**: ws 8.19
- **终端**: node-pty (tmux 后端)
- **鉴权**: JWT + bcrypt
- **安全**: helmet, express-rate-limit, CORS

### Telegram Bot
- **框架**: Telegraf 4.16
- **架构**: Group + Forum Topics 模式
- **代理**: undici (HTTP/HTTPS), socks-proxy-agent (SOCKS)
- **状态管理**: 持久化 JSON 存储

### Claude 集成
- **CLI**: Claude Code CLI
- **会话管理**: session_id 持久化
- **流式输出**: stream-json 解析
- **模型支持**: Sonnet 4.5 / Opus 4.6 / Haiku 4.5

## 项目结构

```
claude-web/
├── src/                    # 前端源代码
│   ├── components/         # React 组件
│   │   ├── Login.tsx       # 登录界面
│   │   ├── Terminal.tsx    # xterm.js 终端
│   │   ├── Sidebar.tsx     # 会话侧边栏
│   │   └── SessionForm.tsx # 会话创建表单
│   ├── hooks/             # React Hooks
│   │   ├── useAuth.ts     # 鉴权 Hook
│   │   └── useWebSocket.ts # WebSocket Hook
│   ├── lib/               # 工具库
│   │   └── api.ts         # API 客户端
│   ├── styles/            # 样式文件
│   ├── App.tsx            # 根组件
│   └── main.tsx           # 入口文件
│
├── server/                # Web 服务器
│   ├── index.ts           # 服务器主入口
│   ├── auth.ts            # JWT 鉴权
│   ├── session-manager.ts # tmux 会话管理
│   ├── security.ts        # 安全中间件
│   └── types.ts           # 类型定义
│
├── telegram/              # Telegram Bot
│   ├── bot/               # Bot 核心
│   │   ├── telegram.ts    # Bot 主类
│   │   ├── handlers.ts    # 消息处理器
│   │   ├── commands.ts    # 命令处理器
│   │   ├── state.ts       # 状态管理器
│   │   ├── auth.ts        # 鉴权逻辑
│   │   ├── callback-registry.ts # 交互式回调
│   │   └── message-utils.ts     # 消息工具
│   ├── claude/            # Claude CLI 集成
│   │   ├── client.ts      # Claude 客户端
│   │   └── executor.ts    # 执行器
│   ├── types/             # 类型定义
│   │   └── index.ts       # 核心类型
│   ├── utils/             # 工具函数
│   │   ├── env.ts         # 环境变量
│   │   ├── logger.ts      # 日志工具
│   │   └── config.ts      # 配置加载
│   └── index.ts           # Bot 入口
│
├── data/                  # 数据目录
│   ├── sessions.json      # Web 会话数据
│   └── telegram-states.json # Telegram 状态数据
│
├── docs/                  # 项目文档
│   └── PROJECT_INIT.md    # 本文档
│
├── dist/                  # 前端构建产物
├── deploy.sh              # 部署脚本 (systemd)
├── dev.sh                 # 开发启动脚本
├── package.json           # 依赖配置
├── tsconfig.json          # TypeScript 配置
├── vite.config.ts         # Vite 配置
├── index.html             # HTML 模板
├── README.md              # 项目主文档
├── plan.md                # Session 改造计划
├── .env -> prd.env        # 环境变量软链接
├── dev.env                # 开发环境配置
└── prd.env                # 生产环境配置
```

## 核心功能

### 1. Web Terminal (Browser-based)

**架构特点**:
- tmux 守护进程 + node-pty 临时附加 PTY
- WebSocket 双向通信
- 会话持久化（服务器重启后会话保持）

**工作流程**:
```
Client (xterm.js)
    ↓ WebSocket
Node.js Server
    ↓ spawn temp PTY (tmux attach)
tmux session (persistent)
    ↓ bash / claude cli
```

**API 端点**:
- `POST /api/login` - 登录获取 JWT
- `GET /api/sessions` - 获取会话列表
- `POST /api/sessions` - 创建新会话
- `DELETE /api/sessions/:id` - 删除会话
- `POST /api/sessions/:id/input` - 发送输入（IM 集成）
- `GET /api/sessions/:id/screen` - 捕获屏幕内容（IM 集成）
- `POST /api/sessions/:id/restart` - 重启会话
- `WebSocket /ws?sessionId=<id>` - 实时终端通信

### 2. Telegram Bot (Group + Forum Topics 模式)

**架构创新**:
- **一个 Topic = 一个独立 Session**
- 不同 Topic 可并行工作，互不干扰
- 取消传统的 userId → activeSessionId 切换模式

**核心概念**:
```
Telegram Group (授权的 Chat ID)
  ├── General Topic
  │     └── 全局命令: /login, /setcwd, /status
  │
  ├── Topic A (thread_id: 42)
  │     └── Session A (独立工作目录、Claude 上下文)
  │
  └── Topic B (thread_id: 58)
        └── Session B (并行执行，完全独立)
```

**数据模型**:
```typescript
// Session: 按 (groupId, topicId) 索引
interface Session {
  id: string;                  // UUID
  name: string;                // topic 名称
  topicId: number;             // message_thread_id
  groupId: number;             // Telegram Group chat ID
  claudeSessionId?: string;    // Claude CLI session_id
  prevClaudeSessionId?: string;// 用于 /rewind
  cwd: string;                 // 工作目录
  model?: string;              // 模型选择
  planMode?: boolean;          // Plan mode 状态
  messageHistory: Message[];   // 最近 50 条
}

// Group State: 全局配置
interface GroupState {
  groupId: number;
  defaultCwd: string;          // 新 Topic 默认目录
  defaultModel?: string;       // 默认模型
}
```

**命令系统**:

*General Topic 命令*:
- `/login <token>` - 绑定 Bot 到 Group
- `/start` - 欢迎信息
- `/help` - 帮助文档
- `/status` - 查看所有 Topic 会话状态
- `/setcwd <path>` - 设置新 Topic 默认工作目录
- `/model` - 设置全局默认模型


*Topic 内命令*:
- `/cd <path>` - 切换当前 Topic 工作目录
- `/clear` - 清空 Claude 上下文
- `/compact` - 压缩 Claude 上下文
- `/rewind` - 撤销最后一轮对话
- `/plan <msg>` - Plan 模式（只规划不执行）
- `/stop` - 停止当前任务
- `/model` - 切换当前 Topic 模型
- `/info` - 查看会话详情

**流式输出处理**:
- 实时显示工具调用进度（Read/Write/Edit/Bash...）
- 排队等待通知 + 锁获取通知
- 自动重试 + 会话重置
- 流式文本消息立即发送
- 文件变更 → 生成 HTML diff 报告（GitHub 风格 + 语法高亮）

**交互式工具**:
- `AskUserQuestion` - 显示 Inline Keyboard 选择
- `ExitPlanMode` - Plan 批准/拒绝 UI
- 自动检测 CLI auto-denial，显示 Telegram UI 收集用户输入

**Plan Mode 工作流**:
1. `/plan <message>` → Claude 输出方案
2. Bot 提示：回复 "ok" 或 "确认" 将压缩上下文并执行
3. 用户确认 → 自动 compact → 发送执行指令
4. 用户其他回复 → 继续讨论方案

### 3. Claude CLI 集成

**执行器特性**:
- 自动锁管理（防止并发冲突）
- 排队机制（任务顺序执行）
- 自动重试（超时/崩溃 → 重试 1 次）
- 会话溢出自动重置
- 用户主动中断（/stop）

### 4. Token 使用统计

**错误分类**:
- `RECOVERABLE` - 超时/崩溃 → 重试
- `SESSION_RECOVERABLE` - 上下文溢出 → 清除 session 重试
- `FATAL` - CLI 不可用 → 不重试
- `ABORTED` - 用户主动停止

**流事件解析**:
- `system` - 系统通知（queued, lock_acquired, session_reset...）
- `assistant` - Claude 输出（文本块 + 工具调用）
- `user` - 工具结果（含 structuredPatch）
- `result` - 最终响应（session_id, usage, cost...）
- `compact` - 压缩进度

## 环境配置

### 环境变量文件

**开发环境** (`dev.env`):
```env
PORT=9000
JWT_SECRET=claude-web-f8a3e7b1d9c2
PASSWORD=<已配置>

# Telegram Bot
TELEGRAM_BOT_TOKEN=<已配置>
BOT_ACCESS_TOKEN=<已配置>
AUTHORIZED_CHAT_ID=
DEFAULT_WORK_DIR=/home/jason/assistant

# 代理
http_proxy=http://127.0.0.1:7890
https_proxy=http://127.0.0.1:7890
```

**生产环境** (`prd.env`):
```env
PORT=9000
JWT_SECRET=<已配置>
PASSWORD=<已配置>

# Telegram Bot
TELEGRAM_BOT_TOKEN=<已配置>
BOT_ACCESS_TOKEN=<已配置>
AUTHORIZED_CHAT_ID=
DEFAULT_WORK_DIR=/home/jason/assistant

# 代理
http_proxy=http://127.0.0.1:7890
https_proxy=http://127.0.0.1:7890
```

**注意**:
- `AUTHORIZED_CHAT_ID` 首次 `/login` 后自动填充
- `.env` 是软链接，默认指向 `prd.env`

### 必需软件

1. **Node.js** >= 18
2. **tmux** >= 3.0
3. **Claude CLI** (`claude` 命令可用)
4. **npm** 或 **pnpm**

## 启动方式

### 开发环境

```bash
# 方式 1: 使用 dev.sh 脚本（推荐）
./dev.sh

# 方式 2: 手动启动
ln -sf dev.env .env
npm run dev
```

**开发模式启动**:
- 前端: Vite dev server (http://localhost:5173)
- 后端: tsx watch server/index.ts (http://localhost:9000)
- Telegram: tsx watch telegram/index.ts

**特性**:
- Vite HMR (前端热更新)
- tsx watch (后端自动重启)
- .env 文件热重载（Telegram Bot）

### 生产环境

```bash
# 部署（构建 + systemd 启动）
./deploy.sh deploy

# 其他命令
./deploy.sh start    # 启动服务
./deploy.sh stop     # 停止服务
./deploy.sh restart  # 重启服务
./deploy.sh status   # 查看状态
./deploy.sh logs     # 查看日志
```

**systemd 服务**:
- `claude-web.service` - Web 服务器
- `claude-telegram.service` - Telegram Bot

**部署流程**:
1. `npm run build` → 构建前端到 `dist/`
2. 软链接 `prd.env` → `.env`
3. `systemctl --user daemon-reload`
4. `systemctl --user enable/restart` 服务
5. 验证服务状态

## 数据持久化

### Web Sessions

**存储**: `data/sessions.json`

```json
{
  "sessions": {
    "uuid-1": {
      "id": "uuid-1",
      "name": "session-1",
      "tmuxName": "cw-abc12345",
      "createdAt": 1234567890
    }
  }
}
```

### Telegram States

**存储**: `data/telegram-states.json`

```json
{
  "sessions": {
    "-100123456789:42": {
      "id": "uuid-1",
      "name": "项目A",
      "topicId": 42,
      "groupId": -100123456789,
      "claudeSessionId": "session-abc123",
      "cwd": "/home/jason/projects/project-a",
      "model": "claude-sonnet-4-5-20250929",
      "messageHistory": [...]
    }
  },
  "groups": {
    "-100123456789": {
      "groupId": -100123456789,
      "defaultCwd": "/home/jason/assistant",
      "defaultModel": "claude-sonnet-4-5-20250929",
      "lastActivity": 1234567890
    }
  }
}
```

**自动保存**:
- 防抖 500ms
- 原子写入（.tmp → rename）
- 每 7 天自动清理不活跃会话

## 安全特性

### Web 服务器

1. **鉴权**: JWT (HS256)
2. **密码**: bcrypt hash
3. **CORS**: 白名单模式
4. **Rate Limit**: 100 req/15min (登录 5 req/15min)
5. **CSP**: 严格内容安全策略
6. **Helmet**: 安全 HTTP 头
7. **WebSocket**:
   - 5 秒鉴权超时
   - 心跳检测（30s）
   - 验证后才能访问会话

### Telegram Bot

1. **鉴权**:
   - `/login <token>` - 时间安全比较
   - Group ID 绑定（单 Group 模式）
2. **代理支持**:
   - HTTP/HTTPS (undici)
   - SOCKS5 (Telegraf 配置)

## 关键文件说明

### 配置文件

- `package.json` - 依赖 + 脚本
- `tsconfig.json` - TypeScript 编译配置
- `vite.config.ts` - Vite 开发/构建配置
- `.gitignore` - Git 忽略规则

### 文档

- `README.md` - 项目主文档（架构、API、使用说明）
- `plan.md` - Session 改造计划（Group + Forum Topics 设计）
- `docs/PROJECT_INIT.md` - 本初始化报告

### 脚本

- `dev.sh` - 开发启动脚本（kill 旧进程 + npm run dev）
- `deploy.sh` - 生产部署脚本（systemd 管理）

## 已知配置

### 开发环境

- **Web 端口**: 9000
- **Vite 端口**: 5173
- **默认工作目录**: /home/jason/assistant
- **代理**: http://127.0.0.1:7890

### Telegram Bot

- **Bot Token**: 已配置
- **Access Token**: 已配置
- **Authorized Chat ID**: 待首次 `/login` 后自动填充
- **Claude CLI 路径**: `claude` (从 PATH 查找)
- **最大 Turns**: 300
- **命令超时**: 600 秒

## 代码质量特性

1. **TypeScript 严格模式**: `strict: true`
2. **ESM 模块**: `"type": "module"`
3. **错误处理**: 统一 ClaudeExecutionError 分类
4. **日志**: 结构化日志（logger）
5. **异步安全**: Promise 链防止并发乱序
6. **原子操作**: 文件写入使用 .tmp + rename

## 扩展性设计

### 支持的 Claude 模型

当前可切换：
- `claude-sonnet-4-5-20250929` (默认)
- `claude-opus-4-6`
- `claude-haiku-4-5-20251001`

添加新模型：修改 `telegram/bot/commands.ts` 中的 `MODEL_OPTIONS`

### Telegram 多 Group 支持

当前：单 Group 绑定
扩展：移除 `AUTHORIZED_CHAT_ID` 检查，改用 Group → Bot 的多对一映射

### Web 多租户

当前：单用户（全局 PASSWORD）
扩展：添加用户表 + session → userId 映射

## 待办事项（来自 plan.md）

**已完成**:
- ✅ Group + Forum Topics 架构实现
- ✅ Session 按 (groupId, topicId) 索引
- ✅ 流式输出 + 工具调用进度
- ✅ 交互式工具（AskUserQuestion/ExitPlanMode）
- ✅ HTML diff 报告生成
- ✅ Plan mode 工作流
- ✅ 模型切换（全局 + Topic）

**未来优化**:
- [ ] Topic 名称自动同步（当前默认 `topic-{id}`）
- [ ] 文件变更 diff 内联显示（当前发送 HTML 附件）
- [ ] Session 清理策略优化（当前固定 7 天）
- [ ] 更细粒度的权限控制（Group 级别）

## 性能特性

1. **Web Sessions**: tmux 守护进程保持会话不中断
2. **Telegram Bot**:
   - 排队锁机制避免并发冲突
   - 流式输出减少延迟感知
   - 防抖保存避免频繁 I/O
3. **Claude CLI**:
   - session_id 复用减少上下文重建
   - 自动 compact 控制 token 使用

## 监控与调试

### 日志

- **开发**: 控制台输出
- **生产**: systemd journal
  ```bash
  journalctl --user -u claude-web -f
  journalctl --user -u claude-telegram -f
  ```

### 状态检查

```bash
# Web 会话
curl http://localhost:9000/api/sessions -H "Authorization: Bearer <token>"

# Telegram 状态
cat data/telegram-states.json | jq .
```

## 总结

**项目成熟度**: ✅ 生产就绪

**核心优势**:
1. **双接口**: Web Terminal + Telegram Bot
2. **持久化**: tmux 后端 + JSON 状态存储
3. **并发友好**: Topic 并行 + 锁机制
4. **交互式**: 流式进度 + 键盘 UI
5. **可视化**: HTML diff 报告 + 语法高亮
6. **安全**: JWT + bcrypt + CORS + Rate Limit

**适用场景**:
- 个人 Claude Code 多项目管理
- Telegram 移动端开发
- 团队协作（需扩展多 Group 支持）

**文档完整性**: ⭐⭐⭐⭐⭐
- README.md: 详细架构说明
- plan.md: 设计思路记录
- 代码注释: 关键逻辑清晰

---

*本报告由 Claude Code 自动生成于 2026-02-09*
