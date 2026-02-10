# 使用统计脚本

## 脚本列表

### 1. populate-usage-history.ts
**用途**: 填充历史使用数据（用于测试或初始化）

**功能**:
- 生成过去 7 天的模拟使用数据
- 每天 20-50 条随机记录
- 时间分布：70% 在工作时间（9:00-18:00），30% 随机
- 模型分布：Sonnet 70%, Opus 20%, Haiku 10%
- Token 范围：输入 5K-55K，输出 1K-21K

**使用方法**:
```bash
cd /home/jason/projects/claude-web
tsx scripts/populate-usage-history.ts
```

**输出示例**:
```
开始填充历史使用数据...

生成 2026-02-03 的数据...
  ✓ 生成了 28 条记录
生成 2026-02-04 的数据...
  ✓ 生成了 22 条记录
...

✅ 完成！总共生成了 217 条历史记录

统计预览:
今日: 32 次请求, 1.43M tokens, $15.8275
昨日: 44 次请求, 1.64M tokens, $22.1951
```

### 2. verify-usage-stats.ts
**用途**: 验证和查看使用统计数据

**功能**:
- 显示过去 7 天的详细统计
- 按小时分解显示
- 可视化进度条
- 标记今天和昨天

**使用方法**:
```bash
cd /home/jason/projects/claude-web
tsx scripts/verify-usage-stats.ts
```

**输出示例**:
```
📊 使用统计数据验证
============================================================

2026-02-08 (昨天)
------------------------------------------------------------
请求数: 44
Token 总量: 1.64M
  输入: 1.19M
  输出: 445.2K
预估费用: $22.1951

按小时分布:
  09:00 ███████████░░░░░░░░░ 140.0K ($2.9932)
  14:00 ████████████████████ 264.5K ($4.1352)
  ...
```

## 数据文件

### data/usage-stats.json
存储格式：
```json
{
  "records": [
    {
      "timestamp": 1770101625000,
      "model": "claude-sonnet-4-5-20250929",
      "inputTokens": 16216,
      "outputTokens": 8429,
      "costUSD": 0.175083
    },
    ...
  ]
}
```

## 常见操作

### 重新生成数据
```bash
# 删除旧数据
rm -f data/usage-stats.json

# 生成新数据
tsx scripts/populate-usage-history.ts

# 验证数据
tsx scripts/verify-usage-stats.ts
```

### 查看实时统计
在 Telegram General 话题中：
```
/usage              # 今日统计
/usage yesterday    # 昨日统计
/usage 2026-02-08   # 指定日期
```

### 清空数据
```bash
rm -f data/usage-stats.json
```

## 注意事项

1. **模拟数据仅供测试**
   - 实际生产环境会自动记录真实数据
   - 脚本生成的是随机模拟数据

2. **时间戳格式**
   - Unix 时间戳（毫秒）
   - 使用本地时区

3. **数据持久化**
   - 自动保存（防抖 1 秒）
   - 保留 30 天数据
   - 每小时自动清理

4. **重启服务**
   - 脚本修改数据后需要重启 Bot
   - 或等待自动加载（启动时）

## 开发建议

### 添加新的统计维度
编辑 `telegram/bot/usage-tracker.ts`：
- 在 `UsageRecord` 接口添加字段
- 在 `track()` 方法记录数据
- 在 `getDailyStats()` 中聚合

### 自定义报告格式
编辑 `formatDailyReport()` 方法：
- 调整显示字段
- 修改进度条宽度
- 添加图表元素

---

*创建于 2026-02-09*
