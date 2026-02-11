# Claude Bot 项目文档

生成时间: 2026-02-11

## 项目概述

**项目名称**: claude-bot
**项目位置**: `/home/jason/projects/claude-bot`
**项目类型**: Telegram Bot + REST API
**主要功能**: 通过 Telegram 和本地 API 与 Claude Code CLI 交互，支持多 topic 并行开发、Goal 自动调度、Notion 集成

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
│   ├── orchestrator/         # Goal 自动调度引擎
│   │   ├── index.ts         # GoalOrchestrator：drive 生命周期、任务派发、merge
│   │   ├── goal-state.ts    # 状态持久化：读写 data/goals/<id>.json
│   │   ├── goal-branch.ts   # Git 分支操作：创建/合并/清理 goal 和子任务分支
│   │   └── task-scheduler.ts # 调度算法：依赖分析、并发控制、进度统计
│   ├── api/
│   │   ├── server.ts        # HTTP API 服务器 (127.0.0.1:3456)
│   │   ├── routes/          # RESTful 路由（含 goals.ts）
│   │   ├── types.ts         # API 类型定义
│   │   └── middleware.ts    # JSON 响应工具
│   ├── utils/
│   │   ├── config.ts        # 环境变量 → TelegramBotConfig
│   │   ├── env.ts           # AUTHORIZED_CHAT_ID 读写
│   │   ├── logger.ts        # 日志工具
│   │   ├── git-utils.ts     # Git 操作：worktree、merge 等
│   │   └── topic-path.ts    # Topic 目录命名
│   └── types/index.ts       # 全局类型：Session, StreamEvent, GoalDriveState 等
│
├── monitor/                  # 进程监控守护进程
│   ├── index.ts             # 入口
│   ├── process-monitor.ts   # 崩溃检测 + Telegram 通知
│   └── types.ts             # 监控类型
│
├── skills/                   # Claude Code Skills
│   ├── goal/SKILL.md        # Goal 管理：创建、继续、自动驱动
│   ├── idea/SKILL.md        # 想法记录与推进
│   ├── merge/SKILL.md       # 分支合并 + 清理 + DevLog
│   ├── devlog/SKILL.md      # 开发日志记录到 Notion
│   ├── review/SKILL.md      # 日报/周报自动生成
│   ├── qdev/SKILL.md        # 快速创建开发分支
│   └── tg/SKILL.md          # Telegram Bot API 操作
│
├── scripts/
│   └── daily-review.sh      # Cron：每天 9:00 自动触发日报
│
├── data/                     # 持久化数据
│   ├── telegram-states.json # Bot 状态（sessions + groups）
│   ├── goals/               # Goal Drive 状态文件（<goalId>.json）
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

### GoalOrchestrator（Goal 自动调度引擎）

将 Notion Goal 的子任务自动并行推进，完成后自动 merge：

```
TelegramBot
├── StateManager
├── ClaudeClient
├── MessageQueue
├── ApiServer
└── GoalOrchestrator          ← Goal 自动调度
    ├── 从 Notion 解析子任务和依赖关系
    ├── 按依赖图调度（最多并发 3 个）
    ├── 每个子任务 → 独立 worktree + Telegram Topic + Claude session
    ├── 完成后自动 merge 到 goal 分支、清理资源
    └── 全程 Telegram 通知进度
```

**调度流程**:
1. `/goal <名称>` → 匹配 Notion Goal → 解析子任务
2. 自动调用 `POST /api/goals/<id>/drive` 启动 drive
3. 创建 `goal/<name>` 分支和 worktree
4. 按依赖关系批量派发子任务（`getNextBatch()`）
5. 每个子任务完成 → 自动 merge → 派发下一批
6. 全部完成 → 通知用户审核 goal 分支

**Git 分支策略**:
```
main
 └── goal/<goal-name>           ← Orchestrator 创建
      ├── feat/t1-subtask       ← 子任务分支（自动 fork + merge back）
      ├── fix/t2-subtask
      └── feat/t3-subtask
```

**子任务格式**（Notion 页面中编写）:
```markdown
## 子任务
- [ ] `[代码]` t1: 描述            ← 自动执行
- [ ] `[代码]` t2: 描述 — depends: t1  ← 等 t1 完成
- [ ] `[手动]` t3: 描述            ← 通知用户手动处理
- [ ] `[调研]` t4: 描述 — depends: t1, t2
```

**用户干预**: pause / resume / skip / retry / done（手动任务标记完成）

**状态持久化**: `data/goals/<goalId>.json`，Bot 重启后自动恢复运行中的 drives

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
| POST | /api/goals/:id/drive | 启动 Goal 自动驱动 |
| GET | /api/goals/:id/status | 查看 Drive 状态和子任务进度 |
| POST | /api/goals/:id/pause | 暂停 Drive |
| POST | /api/goals/:id/resume | 恢复 Drive |
| POST | /api/goals/:id/tasks/:taskId/skip | 跳过子任务 |
| POST | /api/goals/:id/tasks/:taskId/done | 标记手动任务完成 |
| POST | /api/goals/:id/tasks/:taskId/retry | 重试失败任务 |

### 交互式工具

- `AskUserQuestion` → Inline Keyboard 选项
- `ExitPlanMode` → Plan 批准/拒绝/压缩后执行
- 自动检测 CLI auto-denial，显示 Telegram UI 收集用户输入

## Skills 系统

Skills 是 Claude Code 的扩展能力，通过 `/skill` 命令触发，定义在 `skills/` 目录下。

| Skill | 命令示例 | 说明 |
|-------|---------|------|
| **goal** | `/goal`, `/goal 功能名` | 管理开发目标。无参数列出 Goals；有参数搜索/创建/继续 Goal，自动启动 Drive |
| **idea** | `/idea 想法描述`, `/idea` | 快速记录想法到 Notion；无参数列出未开发 Ideas 并推进 |
| **merge** | `/merge` | 合并当前 worktree 到 main，清理分支/worktree/topic，自动写 DevLog |
| **devlog** | `/devlog` | 记录开发日志到 Notion Dev Log，用 git tag 追踪进度 |
| **review** | `/review`, `/review weekly` | 自动生成日报（默认）或周报，从 Notion + git log 收集数据 |
| **qdev** | `/qdev 任务描述` | 快速 fork topic → 创建 worktree → 发送任务 |
| **tg** | `/tg` | 通过 HTTP API 操作 Telegram Bot |

**典型工作流**: `/idea` 记录 → `/goal` 规划子任务 → GoalOrchestrator 自动执行 → `/merge` 合并 → `/devlog` 记录 → `/review` 回顾

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
- `/goal <名称>` - Goal 管理与自动驱动
- `/idea <描述>` - 记录想法 / 推进想法
- `/merge` - 合并分支并清理
- `/devlog` - 记录开发日志
- `/review` - 生成日报/周报
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
