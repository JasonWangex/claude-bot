# Claude 进程与服务监控守护进程

独立的监控服务，用于检测 Claude CLI 会话和 systemd 服务的异常状态并发送 Discord 通知。

## 功能特性

### 进程监控
- 实时监控所有 Claude CLI 会话进程
- 检测进程异常退出并立即通知
- 自动识别会话所属的 Discord Thread，发送到正确位置
- 3 分钟冷却期，避免同一会话的重复通知

### systemd 服务监控
- 监控 `claude-discord` 等 systemd 服务状态
- 检测服务停止或失败，立即发送告警
- 服务恢复时自动发送恢复通知
- 记录服务失败次数，便于诊断
- 与主 Bot 完全独立，互不影响

## 工作原理

1. **进程扫描**: 定期扫描所有运行中的 `claude` 进程
2. **信息提取**: 从命令行参数中提取 `session-id` 和 `lock-key`（包含 threadId）
3. **状态跟踪**: 记录每个进程的 PID、会话 ID、Thread ID 和启动时间
4. **退出检测**: 通过进程列表对比检测进程退出
5. **异常判断**: 根据运行时间、退出码、系统信号等判断是否为异常退出
6. **通知发送**: 仅对异常退出发送详细的崩溃报告到对应的 Discord Thread 或 #general

## 正常退出 vs 异常退出

### 正常退出（不发送通知）
- Claude 任务完成后自然结束
- 退出码为 0
- 运行时间在正常范围内（2秒 - 1小时）

### 异常退出（发送通知）
以下情况会被判定为异常退出并触发通知：

1. **启动失败**: 运行时间 < 2 秒（可配置 `MONITOR_MIN_RUNTIME`）
2. **进程崩溃**: 检测到非 0 退出码
3. **系统终止**: 检测到 OOM Killer 或其他系统信号
4. **超时被杀**: 运行时间 > 1 小时（可配置 `MONITOR_MAX_RUNTIME`）

## 配置说明

### 环境变量

在 `.env` 文件中配置：

```bash
# --- 进程监控配置 ---
MONITOR_CHECK_INTERVAL=5000
MONITOR_COOLDOWN=180000
MONITOR_MIN_RUNTIME=2
MONITOR_MAX_RUNTIME=3600
MONITOR_SERVICES=claude-discord
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `MONITOR_CHECK_INTERVAL` | 检查进程状态的时间间隔（毫秒） | 5000ms (5秒) |
| `MONITOR_COOLDOWN` | 同一会话的通知冷却期（毫秒） | 180000ms (3分钟) |
| `MONITOR_MIN_RUNTIME` | 最小运行时间阈值（秒），低于此值视为异常 | 2秒 |
| `MONITOR_MAX_RUNTIME` | 最大运行时间阈值（秒），超过此值视为超时 | 3600秒 (1小时) |
| `MONITOR_SERVICES` | 要监控的 systemd 服务列表（逗号分隔） | `claude-discord` |

**服务监控说明**：
- 服务检查间隔固定为 30 秒
- 支持监控多个服务，用逗号分隔，例如：`MONITOR_SERVICES=claude-discord,claude-monitor`
- 注意：不要让 monitor 监控自己（`claude-monitor`），可能导致循环依赖

## 使用方法

### 启动监控

```bash
# 直接运行
npx tsx monitor/index.ts
```

### 生产环境部署（systemd 服务）

监控器已集成到 `deploy.sh` 中，作为 systemd 服务运行：

```bash
# 部署所有服务（包括监控器）
./deploy.sh deploy

# 单独管理监控服务
systemctl --user start claude-monitor
systemctl --user stop claude-monitor
systemctl --user restart claude-monitor
systemctl --user status claude-monitor

# 查看日志
journalctl --user -u claude-monitor -f

# 或使用 deploy.sh 查看所有服务日志
./deploy.sh logs
```

## 通知格式

### Claude 进程退出通知

```
Claude 进程意外退出

时间: 2026-02-09 13:45:30
Session: abc123-def456-789
PID: 12345
Thread: 1234567890
运行时长: 15分30秒
```

### 服务异常通知

```
服务异常

时间: 2026-02-09 14:30:00
服务: claude-discord
状态: 已停止
失败次数: 1

建议: 检查服务日志 journalctl --user -u claude-discord -n 50
```

### 服务恢复通知

```
服务已恢复

时间: 2026-02-09 14:31:00
服务: claude-discord
状态: 运行中
之前失败次数: 1
```

## 目录结构

```
monitor/
├── index.ts              # 守护进程入口
├── process-monitor.ts    # 核心监控逻辑
├── types.ts              # 类型定义
└── README.md             # 文档（本文件）
```

## 技术实现

### 进程识别

通过 `ps aux` 命令查找所有包含 `--session-id` 参数的 `claude` 进程。

### Thread ID 提取

从 `--lock-key` 参数中解析，格式为：
```
--lock-key "guildId:threadId:timestamp"
```

### 通知发送

使用 Discord REST API 直接通过 fetch() 发送消息，不依赖 discord.js。

### 冷却期机制

- 为每个 `session-id` 记录最后一次通知时间
- 在冷却期内（默认 3 分钟）不会重复发送通知
- 避免进程频繁重启时的通知轰炸

## 注意事项

1. **独立性**: 监控进程与主 Bot 完全独立，即使主 Bot 崩溃也能继续监控
2. **资源占用**: 默认 5 秒检查一次，资源消耗极低
3. **权限要求**: 需要能够执行 `ps` 命令查看进程列表
4. **代理配置**: 自动从环境变量读取代理设置

## 故障排查

### 监控未启动

检查环境变量：
```bash
echo $DISCORD_TOKEN
echo $GENERAL_CHANNEL_ID
```

### 未收到通知

1. 检查进程是否真的在运行：`ps aux | grep claude`
2. 检查冷却期是否还在生效（查看日志）
3. 检查 Discord Token 是否正确
4. 检查网络和代理设置

### 重复通知

- 增加 `MONITOR_COOLDOWN` 的值（单位：毫秒）
