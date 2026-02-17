# Claude Code Hooks

这个目录包含 Claude Code CLI 的 hooks 脚本，用于在特定事件发生时通知 Bot。

## 安装

运行 `./deploy.sh deploy` 会自动：
1. 复制 hooks 脚本到 `~/.claude/hooks/`
2. 设置执行权限

## 手动配置

需要手动将以下配置合并到 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/session-end.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/stop.sh"
          }
        ]
      }
    ]
  }
}
```

## Hooks 说明

### session-end.sh
- **触发时机**: Claude session 结束时（正常或异常退出）
- **作用**: 通知 Bot API，用于检测任务异常终止

### stop.sh
- **触发时机**: Claude 完成每次响应后
- **作用**: 通知 Bot API，用于状态同步和监控

## 环境变量

Hooks 脚本会读取以下环境变量：
- `API_PORT`: Bot API 端口（默认 3456）

## API 端点

Hooks 调用的 API 端点：
- `POST http://localhost:3456/api/internal/hooks/session-event`

输入格式（来自 Claude Code）：
```json
{
  "session_id": "abc-123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "default",
  "hook_event_name": "Stop" | "SessionEnd",
  "reason": "clear" | "logout" | "other" (仅 SessionEnd)
}
```

## 测试

测试 hook 是否正常工作：

```bash
# 模拟 SessionEnd hook
echo '{"session_id":"test-123","hook_event_name":"SessionEnd","reason":"other"}' | \
  ~/.claude/hooks/session-end.sh

# 查看 Bot 日志
journalctl --user -u claude-discord -f | grep "hook event"
```
