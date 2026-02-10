# Claude Bot 项目文档

生成时间: 2026-02-10

## 项目概述

**项目名称**: claude-bot
**项目位置**: `/home/jason/projects/claude-bot`
**项目类型**: Telegram Bot + REST API
**主要功能**: 通过 Telegram 和本地 API 与 Claude Code CLI 进行交互，支持多 topic 并行开发

## 技术栈

- **运行时**: Node.js 18+ (ESM, tsx 直接运行 TypeScript)
- **语言**: TypeScript 5.9 (strict mode)
- **Telegram**: Telegraf 4.16
- **Claude**: Claude Code CLI (stream-json 解析)
- **代理**: undici (HTTP/HTTPS), socks-proxy-agent (SOCKS)
- **监控**: 独立 ProcessMonitor 守护进程

## 项目结构

```
claude-bot/
├── telegram/                 # 主应用
│   ├── index.ts             # 入口：加载配置、代理、启动 Bot
│   ├── bot/
│   │   ├── telegram.ts      # TelegramBot 主类：组件初始化、Handler 注册、生命周期
│   │   ├── handlers.ts      # MessageHandler：文本消息处理、Claude 流式执行
│   │   ├── commands.ts      # CommandHandler：所有 / 命令
│   │   ├── message-queue.ts # MessageQueue：生产者-消费者队列 + per-topic 节流
│   │   ├── state.ts         # StateManager：Session 持久化 CRUD
│   │   ├── callback-registry.ts # 交互式 Inline Keyboard 回调
│   │   ├── auth.ts          # 授权检查
│   │   └── message-utils.ts # 消息格式化、HTML 转换、diff 渲染
│   ├── claude/
│   │   ├── client.ts        # ClaudeClient：封装 executor
│   │   └── executor.ts      # ClaudeExecutor：进程管理、流解析、stall 检测
│   ├── api/
│   │   ├── server.ts        # HTTP API 服务器 (127.0.0.1:3456)
│   │   ├── routes/          # RESTful 路由
│   │   ├── types.ts         # API 类型定义
│   │   └── middleware.ts    # JSON 响应工具
│   ├── utils/
│   │   ├── config.ts        # 环境变量 → TelegramBotConfig
│   │   ├── env.ts           # AUTHORIZED_CHAT_ID 读写
│   │   ├── logger.ts        # 日志工具
│   │   ├── git-utils.ts     # Git 操作：worktree、merge 等
│   │   └── topic-path.ts    # Topic 目录命名
│   └── types/index.ts       # 全局类型：Session, StreamEvent, FileChange 等
│
├── monitor/                  # 进程监控守护进程
│   ├── index.ts             # 入口
│   ├── process-monitor.ts   # 崩溃检测 + Telegram 通知
│   └── types.ts             # 监控类型
│
├── skills/                   # Claude Code Skills
│   ├── qdev/SKILL.md        # 快速创建开发分支
│   └── tg/SKILL.md          # Telegram Bot API 操作
│
├── data/                     # 持久化数据
│   ├── telegram-states.json # Bot 状态（sessions + groups）
│   └── processes/           # Claude 进程输出临时文件
│
├── deploy.sh                # 生产部署 (systemd)
├── dev.sh                   # 开发启动
└── package.json             # 依赖配置
```

## 核心架构

### Telegram Bot (Group + Forum Topics)

```
Telegram Group (授权的 Chat ID)
  ├── General Topic → 全局命令: /login, /status, /model
  ├── Topic A (thread_id) → Session A (独立 cwd、Claude 上下文)
  └── Topic B (thread_id) → Session B (并行执行)
```

每个 Topic 是独立的开发会话，支持：
- 独立工作目录和 Claude session
- Git worktree 分支隔离
- 并行执行互不干扰

### 消息队列 (MessageQueue)

生产者-消费者模型，解耦 Claude 输出与 Telegram API：

- **Per-topic 节流**: 普通消息缓冲 15s 后合并发送
- **优先级**: high（立即发送）/ normal（走缓冲区）
- **Rate limiting**: 100ms flush 间隔，35ms 操作间隔
- **429 退避**: 自动读取 retry_after 并暂停
- **Edit 合并**: 连续同 messageId 的 edit 只保留最后一个
- **串行 Promise 链**: 文本发送 + 进度重建严格串行，防止顺序错乱

### Claude CLI 集成

- **Detached 进程**: `spawn({detached: true})` + `unref()`，进程独立于 Bot
- **Stall 检测**: 连续 60s 无输出自动 SIGTERM/SIGKILL
- **排队锁**: per-topic lockKey 防止并发冲突
- **进程注册**: `data/active-processes.json`，Bot 重启后可重连
- **流事件**: system / assistant / user / result / compact

### REST API (127.0.0.1:3456)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/status | 全局状态 |
| GET/POST | /api/topics | 列出/创建 Topic |
| GET/PATCH/DELETE | /api/topics/:id | Topic CRUD |
| POST | /api/topics/:id/fork | Fork（创建 worktree 子 Topic） |
| POST | /api/topics/:id/message | 发消息（唯一触发 Telegram 输出） |
| POST | /api/topics/:id/clear\|compact\|rewind\|stop | 会话操作 |
| GET/PUT | /api/models | 模型管理 |

### 交互式工具

- `AskUserQuestion` → Inline Keyboard 选项
- `ExitPlanMode` → Plan 批准/拒绝/压缩后执行
- 自动检测 CLI auto-denial，显示 Telegram UI 收集用户输入

## 命令系统

### General Topic
- `/login <token>` - 绑定 Bot
- `/status` - 所有 Topic 状态
- `/model` - 全局默认模型

### Topic 内
- `/plan <msg>` - Plan 模式
- `/cd <path>` - 切换工作目录
- `/clear` - 清空上下文
- `/compact` - 压缩上下文
- `/rewind` - 撤销最后一轮
- `/stop` - 停止任务
- `/info` - 会话详情
- `/qdev <描述>` - 快速创建开发分支并发送任务
- `/model` - 切换 Topic 模型
- `/topics` - 管理 Topic

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| TELEGRAM_BOT_TOKEN | 必填 | Bot Token |
| BOT_ACCESS_TOKEN | 必填 | 认证 Token |
| AUTHORIZED_CHAT_ID | /login 后填充 | 授权 Group ID |
| DEFAULT_WORK_DIR | ~/ | 默认工作目录 |
| MAX_TURNS | 20 | Claude 最大轮次 |
| COMMAND_TIMEOUT | 300000 | 命令超时 (5min) |
| STALL_TIMEOUT | 60000 | 无输出超时 (1min) |
| API_PORT | 3456 | API 端口 (0=禁用) |
| WORKTREES_DIR | ${PROJECTS_ROOT}/worktrees | Worktree 目录 |

## 部署

```bash
./deploy.sh deploy   # 完整部署（systemd reload + restart）
./deploy.sh status   # 查看服务状态
./deploy.sh logs     # 查看日志
```

**systemd 服务**:
- `claude-telegram.service` - Telegram Bot
- `claude-monitor.service` - 进程监控

## 可用模型

- `claude-opus-4-6` (Opus 4.6)
- `claude-sonnet-4-5-20250929` (Sonnet 4.5)
- `claude-haiku-4-5-20251001` (Haiku 4.5)
