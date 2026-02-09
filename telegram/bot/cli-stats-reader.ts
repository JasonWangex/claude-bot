/**
 * Claude CLI 统计数据读取器
 * 从 ~/.claude/stats-cache.json 读取官方统计数据
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';

// 模型价格（美元/百万 tokens）
const MODEL_PRICING = {
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
} as const;

// Cache pricing (相对于基础价格的折扣)
const CACHE_READ_DISCOUNT = 0.9;  // 90% 折扣 -> 10% 价格
const CACHE_WRITE_DISCOUNT = 0.25; // 25% 折扣 -> 75% 价格

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

interface CLIStatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  modelUsage: Record<string, ModelUsage>;
  totalSessions: number;
  totalMessages: number;
  hourCounts: Record<string, number>;
}

export interface DailyStats {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
  totalTokens: number;
  modelBreakdown: ModelStats[];
  totalCost: number;
  cacheStats: CacheStats;
}

interface ModelStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUSD: number;
}

interface CacheStats {
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  savingsUSD: number;
  hitRate: number; // cache read / (cache read + input) 的百分比
}

export class CLIStatsReader {
  private statsPath: string;

  constructor() {
    this.statsPath = join(homedir(), '.claude', 'stats-cache.json');
  }

  /**
   * 读取并解析 CLI 统计文件
   */
  private async readStats(): Promise<CLIStatsCache | null> {
    try {
      const raw = await readFile(this.statsPath, 'utf-8');
      try {
        return JSON.parse(raw);
      } catch (parseError: any) {
        logger.error('Failed to parse CLI stats JSON:', parseError.message);
        return null;
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.warn('CLI stats file not found:', this.statsPath);
      } else {
        logger.error('Failed to read CLI stats file:', err.message);
      }
      return null;
    }
  }

  /**
   * 计算单个模型的费用（含 cache 折扣）
   */
  private calculateModelCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number
  ): number {
    const pricing = MODEL_PRICING[model as keyof typeof MODEL_PRICING] || MODEL_PRICING['claude-sonnet-4-5-20250929'];

    // 基础费用
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    // Cache read: 90% 折扣 (只付 10%)
    const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.input * (1 - CACHE_READ_DISCOUNT);

    // Cache write: 25% 折扣 (付 75%)
    const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.input * (1 - CACHE_WRITE_DISCOUNT);

    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  /**
   * 获取指定日期的统计
   */
  async getDailyStats(date: string): Promise<DailyStats | null> {
    const stats = await this.readStats();
    if (!stats) {
      return null;
    }

    // 查找指定日期的 activity
    const activity = stats.dailyActivity.find(a => a.date === date);
    if (!activity) {
      return {
        date,
        messageCount: 0,
        sessionCount: 0,
        toolCallCount: 0,
        totalTokens: 0,
        modelBreakdown: [],
        totalCost: 0,
        cacheStats: {
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          savingsUSD: 0,
          hitRate: 0,
        },
      };
    }

    // 查找指定日期的 model tokens
    const dailyTokens = stats.dailyModelTokens.find(d => d.date === date);
    if (!dailyTokens) {
      return {
        date,
        messageCount: activity.messageCount,
        sessionCount: activity.sessionCount,
        toolCallCount: activity.toolCallCount,
        totalTokens: 0,
        modelBreakdown: [],
        totalCost: 0,
        cacheStats: {
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          savingsUSD: 0,
          hitRate: 0,
        },
      };
    }

    // 按模型计算费用（需要从全局 modelUsage 中获取 cache tokens 的比例）
    const modelBreakdown: ModelStats[] = [];
    let totalTokens = 0;
    let totalCost = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalInput = 0;

    for (const [model, tokens] of Object.entries(dailyTokens.tokensByModel)) {
      const globalUsage = stats.modelUsage[model];
      if (!globalUsage) continue;

      // 计算该模型在全局中的 cache 比例
      const globalTotal = globalUsage.inputTokens + globalUsage.outputTokens;
      if (globalTotal === 0) continue;

      // 假设当天的 cache 比例与全局相同（这是一个近似，因为 CLI 没有按天的 cache 数据）
      const cacheReadRatio = globalUsage.cacheReadInputTokens / (globalUsage.inputTokens + globalUsage.cacheReadInputTokens || 1);
      const cacheWriteRatio = globalUsage.cacheCreationInputTokens / (globalUsage.inputTokens + globalUsage.cacheCreationInputTokens || 1);
      const outputRatio = globalUsage.outputTokens / globalTotal;

      // 估算当天的 tokens 分配
      const dayInput = Math.round(tokens * (1 - outputRatio) * (1 - cacheReadRatio - cacheWriteRatio));
      const dayOutput = Math.round(tokens * outputRatio);
      const dayCacheRead = Math.round(tokens * (1 - outputRatio) * cacheReadRatio);
      const dayCacheWrite = Math.round(tokens * (1 - outputRatio) * cacheWriteRatio);

      const cost = this.calculateModelCost(model, dayInput, dayOutput, dayCacheRead, dayCacheWrite);

      modelBreakdown.push({
        model,
        inputTokens: dayInput,
        outputTokens: dayOutput,
        cacheReadTokens: dayCacheRead,
        cacheWriteTokens: dayCacheWrite,
        totalTokens: tokens,
        costUSD: cost,
      });

      totalTokens += tokens;
      totalCost += cost;
      totalCacheRead += dayCacheRead;
      totalCacheWrite += dayCacheWrite;
      totalInput += dayInput;
    }

    // 计算节省的费用（如果没有 cache，需要支付的费用）
    let savingsUSD = 0;
    for (const ms of modelBreakdown) {
      const pricing = MODEL_PRICING[ms.model as keyof typeof MODEL_PRICING] || MODEL_PRICING['claude-sonnet-4-5-20250929'];
      // Cache read 节省了 90%
      savingsUSD += (ms.cacheReadTokens / 1_000_000) * pricing.input * CACHE_READ_DISCOUNT;
      // Cache write 节省了 25%
      savingsUSD += (ms.cacheWriteTokens / 1_000_000) * pricing.input * CACHE_WRITE_DISCOUNT;
    }

    const hitRate = totalInput + totalCacheRead > 0
      ? (totalCacheRead / (totalInput + totalCacheRead)) * 100
      : 0;

    return {
      date,
      messageCount: activity.messageCount,
      sessionCount: activity.sessionCount,
      toolCallCount: activity.toolCallCount,
      totalTokens,
      modelBreakdown,
      totalCost,
      cacheStats: {
        totalCacheReadTokens: totalCacheRead,
        totalCacheWriteTokens: totalCacheWrite,
        savingsUSD,
        hitRate,
      },
    };
  }

  /**
   * 获取今天的统计
   */
  async getTodayStats(): Promise<DailyStats | null> {
    const today = this.formatDate(new Date());
    return this.getDailyStats(today);
  }

  /**
   * 获取昨天的统计
   */
  async getYesterdayStats(): Promise<DailyStats | null> {
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
   * 格式化统计报告（HTML）
   */
  formatDailyReport(stats: DailyStats, title: string = '使用统计'): string {
    const lines: string[] = [];

    lines.push(`📊 <b>${title}</b>`);
    lines.push(`日期: ${stats.date}`);
    lines.push('');
    lines.push(`消息数: ${stats.messageCount}`);
    lines.push(`会话数: ${stats.sessionCount}`);
    lines.push(`工具调用: ${stats.toolCallCount}`);
    lines.push('');
    lines.push(`<b>Token 使用:</b>`);
    lines.push(`总计: ${this.formatTokens(stats.totalTokens)}`);

    if (stats.modelBreakdown.length > 0) {
      lines.push('');
      lines.push('<b>按模型分解:</b>');
      for (const m of stats.modelBreakdown) {
        const modelName = this.formatModelName(m.model);
        lines.push(`  <b>${modelName}:</b>`);
        lines.push(`    Input: ${this.formatTokens(m.inputTokens)}`);
        lines.push(`    Output: ${this.formatTokens(m.outputTokens)}`);
        if (m.cacheReadTokens > 0) {
          lines.push(`    Cache Read: ${this.formatTokens(m.cacheReadTokens)} (90% 折扣)`);
        }
        if (m.cacheWriteTokens > 0) {
          lines.push(`    Cache Write: ${this.formatTokens(m.cacheWriteTokens)} (25% 折扣)`);
        }
        lines.push(`    费用: $${m.costUSD.toFixed(4)}`);
      }
    }

    lines.push('');
    lines.push(`<b>总费用: $${stats.totalCost.toFixed(4)}</b>`);

    // Cache 效果分析
    if (stats.cacheStats.totalCacheReadTokens > 0 || stats.cacheStats.totalCacheWriteTokens > 0) {
      lines.push('');
      lines.push('<b>Cache 效果:</b>');
      if (stats.cacheStats.totalCacheReadTokens > 0) {
        lines.push(`  Cache Read: ${this.formatTokens(stats.cacheStats.totalCacheReadTokens)}`);
      }
      if (stats.cacheStats.totalCacheWriteTokens > 0) {
        lines.push(`  Cache Write: ${this.formatTokens(stats.cacheStats.totalCacheWriteTokens)}`);
      }
      lines.push(`  节省费用: $${stats.cacheStats.savingsUSD.toFixed(4)}`);
      lines.push(`  命中率: ${stats.cacheStats.hitRate.toFixed(1)}%`);
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
   * 格式化 Token 数量（K/M 单位）
   */
  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(2)}M`;
    } else if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}K`;
    }
    return String(tokens);
  }
}
