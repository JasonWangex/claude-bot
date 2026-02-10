/**
 * Claude Code Usage Reader - 基于 ccusage 思路
 * 从 ~/.claude/projects/ 目录的 JSONL 文件读取使用数据
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

// 模型价格（美元/百万 tokens）
const MODEL_PRICING = {
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
} as const;

// Cache 折扣率
const CACHE_READ_DISCOUNT = 0.9;  // 90% 折扣
const CACHE_WRITE_DISCOUNT = 0.25; // 25% 折扣

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface MessageRecord {
  type: string;
  timestamp: string;
  message?: {
    model: string;
    usage: Usage;
  };
  sessionId: string;
}

export interface DailyStats {
  date: string;
  messageCount: number;
  sessionIds: Set<string>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  modelStats: Map<string, ModelStats>;
}

interface ModelStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messageCount: number;
}

export interface FormattedStats {
  date: string;
  messageCount: number;
  sessionCount: number;
  totalTokens: number;
  totalCost: number;
  models: Array<{
    name: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
  }>;
  cacheStats: {
    totalReadTokens: number;
    totalWriteTokens: number;
    savingsUSD: number;
    hitRate: number;
  };
}

export class UsageReader {
  private projectsDir: string;

  constructor() {
    this.projectsDir = join(homedir(), '.claude', 'projects');
  }

  /**
   * 读取所有项目目录下的 JSONL 文件
   */
  private async readAllJsonlFiles(): Promise<MessageRecord[]> {
    const records: MessageRecord[] = [];

    try {
      const projectDirs = await readdir(this.projectsDir);

      for (const dir of projectDirs) {
        const dirPath = join(this.projectsDir, dir);
        try {
          const files = await readdir(dirPath);

          for (const file of files) {
            if (file.endsWith('.jsonl')) {
              const filePath = join(dirPath, file);
              try {
                const content = await readFile(filePath, 'utf-8');
                const lines = content.trim().split('\n').filter(l => l.trim());

                for (const line of lines) {
                  try {
                    const record = JSON.parse(line) as MessageRecord;
                    if (record.type === 'assistant' && record.message?.usage) {
                      records.push(record);
                    }
                  } catch (parseError) {
                    // 忽略无法解析的行
                  }
                }
              } catch (readError) {
                // 忽略无法读取的文件
              }
            }
          }
        } catch (dirError) {
          // 忽略无法读取的目录
        }
      }
    } catch (error: any) {
      logger.error('Failed to read projects directory:', error.message);
    }

    return records;
  }

  /**
   * 按日期聚合统计
   */
  private aggregateByDate(records: MessageRecord[]): Map<string, DailyStats> {
    const dailyMap = new Map<string, DailyStats>();

    for (const record of records) {
      const date = record.timestamp.split('T')[0]; // YYYY-MM-DD
      const model = record.message?.model || 'unknown';
      const usage = record.message?.usage;

      if (!usage) continue;

      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          date,
          messageCount: 0,
          sessionIds: new Set(),
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          modelStats: new Map(),
        });
      }

      const daily = dailyMap.get(date)!;
      daily.messageCount++;
      daily.sessionIds.add(record.sessionId);
      daily.totalInputTokens += usage.input_tokens || 0;
      daily.totalOutputTokens += usage.output_tokens || 0;
      daily.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
      daily.totalCacheWriteTokens += usage.cache_creation_input_tokens || 0;

      // 按模型统计
      if (!daily.modelStats.has(model)) {
        daily.modelStats.set(model, {
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          messageCount: 0,
        });
      }

      const modelStat = daily.modelStats.get(model)!;
      modelStat.inputTokens += usage.input_tokens || 0;
      modelStat.outputTokens += usage.output_tokens || 0;
      modelStat.cacheReadTokens += usage.cache_read_input_tokens || 0;
      modelStat.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
      modelStat.messageCount++;
    }

    return dailyMap;
  }

  /**
   * 计算单个模型的费用
   */
  private calculateModelCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number
  ): number {
    const pricing = MODEL_PRICING[model as keyof typeof MODEL_PRICING]
      || MODEL_PRICING['claude-sonnet-4-5-20250929'];

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.input * (1 - CACHE_READ_DISCOUNT);
    const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.input * (1 - CACHE_WRITE_DISCOUNT);

    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  /**
   * 获取指定日期的统计数据
   */
  async getDailyStats(date: string): Promise<FormattedStats | null> {
    const records = await this.readAllJsonlFiles();
    const dailyMap = this.aggregateByDate(records);
    const daily = dailyMap.get(date);

    if (!daily) {
      return null;
    }

    const models: FormattedStats['models'] = [];
    let totalCost = 0;
    let totalCacheSavings = 0;

    for (const modelStat of daily.modelStats.values()) {
      // 过滤掉没有实际使用的模型（如 <synthetic>）
      const totalTokens = modelStat.inputTokens + modelStat.outputTokens +
                          modelStat.cacheReadTokens + modelStat.cacheWriteTokens;
      if (totalTokens === 0) {
        continue;
      }

      const cost = this.calculateModelCost(
        modelStat.model,
        modelStat.inputTokens,
        modelStat.outputTokens,
        modelStat.cacheReadTokens,
        modelStat.cacheWriteTokens
      );

      // 计算 cache 节省的费用
      const pricing = MODEL_PRICING[modelStat.model as keyof typeof MODEL_PRICING]
        || MODEL_PRICING['claude-sonnet-4-5-20250929'];
      const cacheReadSavings = (modelStat.cacheReadTokens / 1_000_000) * pricing.input * CACHE_READ_DISCOUNT;
      const cacheWriteSavings = (modelStat.cacheWriteTokens / 1_000_000) * pricing.input * CACHE_WRITE_DISCOUNT;

      totalCost += cost;
      totalCacheSavings += cacheReadSavings + cacheWriteSavings;

      models.push({
        name: modelStat.model,
        inputTokens: modelStat.inputTokens,
        outputTokens: modelStat.outputTokens,
        cacheReadTokens: modelStat.cacheReadTokens,
        cacheWriteTokens: modelStat.cacheWriteTokens,
        cost,
      });
    }

    const totalInputForHitRate = daily.totalInputTokens + daily.totalCacheReadTokens;
    const hitRate = totalInputForHitRate > 0
      ? (daily.totalCacheReadTokens / totalInputForHitRate) * 100
      : 0;

    return {
      date,
      messageCount: daily.messageCount,
      sessionCount: daily.sessionIds.size,
      totalTokens: daily.totalInputTokens + daily.totalOutputTokens +
                   daily.totalCacheReadTokens + daily.totalCacheWriteTokens,
      totalCost,
      models: models.sort((a, b) => b.cost - a.cost), // 按费用降序
      cacheStats: {
        totalReadTokens: daily.totalCacheReadTokens,
        totalWriteTokens: daily.totalCacheWriteTokens,
        savingsUSD: totalCacheSavings,
        hitRate,
      },
    };
  }

  /**
   * 获取今天的统计
   */
  async getTodayStats(): Promise<FormattedStats | null> {
    const today = this.formatDate(new Date());
    return this.getDailyStats(today);
  }

  /**
   * 获取昨天的统计
   */
  async getYesterdayStats(): Promise<FormattedStats | null> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return this.getDailyStats(this.formatDate(yesterday));
  }

  /**
   * 格式化日期为 YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * 格式化统计报告（Telegram HTML 格式）
   */
  formatReport(stats: FormattedStats, title: string = '使用统计'): string {
    const lines: string[] = [];

    lines.push(`📊 <b>${this.escapeHtml(title)}</b>`);
    lines.push(`日期: ${stats.date}`);
    lines.push('');
    lines.push(`💬 消息数: ${stats.messageCount}`);
    lines.push(`🔗 会话数: ${stats.sessionCount}`);
    lines.push(`🎯 总 Token: ${this.formatTokens(stats.totalTokens)}`);
    lines.push(`💰 总费用: $${stats.totalCost.toFixed(4)}`);

    if (stats.models.length > 0) {
      lines.push('');
      lines.push('<b>📦 按模型分解:</b>');
      for (const m of stats.models) {
        const modelName = this.escapeHtml(this.formatModelName(m.name));
        lines.push(`\n<b>${modelName}:</b>`);
        lines.push(`  ↗️ Input: ${this.formatTokens(m.inputTokens)}`);
        lines.push(`  ↘️ Output: ${this.formatTokens(m.outputTokens)}`);
        if (m.cacheReadTokens > 0) {
          lines.push(`  📖 Cache Read: ${this.formatTokens(m.cacheReadTokens)}`);
        }
        if (m.cacheWriteTokens > 0) {
          lines.push(`  📝 Cache Write: ${this.formatTokens(m.cacheWriteTokens)}`);
        }
        lines.push(`  💵 费用: $${m.cost.toFixed(4)}`);
      }
    }

    // Cache 效果分析
    if (stats.cacheStats.totalReadTokens > 0 || stats.cacheStats.totalWriteTokens > 0) {
      lines.push('');
      lines.push('<b>⚡ Cache 效果:</b>');
      if (stats.cacheStats.totalReadTokens > 0) {
        lines.push(`  📖 Read: ${this.formatTokens(stats.cacheStats.totalReadTokens)}`);
      }
      if (stats.cacheStats.totalWriteTokens > 0) {
        lines.push(`  📝 Write: ${this.formatTokens(stats.cacheStats.totalWriteTokens)}`);
      }
      lines.push(`  💎 节省: $${stats.cacheStats.savingsUSD.toFixed(4)}`);
      lines.push(`  🎯 命中率: ${stats.cacheStats.hitRate.toFixed(1)}%`);
    }

    return lines.join('\n');
  }

  /**
   * 格式化模型名称
   */
  private formatModelName(model: string): string {
    const names: Record<string, string> = {
      'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
      'claude-opus-4-6': 'Opus 4.6',
      'claude-opus-4-5-20251101': 'Opus 4.5',
      'claude-haiku-4-5-20251001': 'Haiku 4.5',
    };
    return names[model] || model;
  }

  /**
   * 格式化 Token 数量
   */
  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(2)}M`;
    } else if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}K`;
    }
    return String(tokens);
  }

  /**
   * 转义 HTML 特殊字符
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
