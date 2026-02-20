/**
 * LiteLLM 定价服务
 *
 * 从 LiteLLM GitHub 获取 Claude 模型定价数据，本地缓存 24h。
 * 提供 calculateCost(usage, model) 计算单条费用。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

export interface ModelPricing {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_FILE = join(__dirname, '../../data/litellm-pricing.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export class PricingService {
  private pricing = new Map<string, ModelPricing>();
  private lastFetchAt = 0;

  /** 启动时调用：加载缓存，过期则拉新 */
  async init(): Promise<void> {
    if (this.loadFromCache()) {
      if (Date.now() - this.lastFetchAt < CACHE_MAX_AGE_MS) {
        logger.info(`[PricingService] Loaded from cache (${this.pricing.size} models)`);
        return;
      }
    }
    await this.fetchAndCache();
  }

  /** 每日刷新（对齐扫描前调用） */
  async refreshIfNeeded(): Promise<void> {
    if (Date.now() - this.lastFetchAt < CACHE_MAX_AGE_MS) return;
    await this.fetchAndCache();
  }

  /** 计算单条记录费用 */
  calculateCost(usage: TokenUsage, model: string): number {
    const p = this.getPricing(model);
    if (!p) return 0;

    const inputCost = usage.input_tokens * p.input_cost_per_token;
    const outputCost = usage.output_tokens * p.output_cost_per_token;
    const cacheReadCost = (usage.cache_read_input_tokens ?? 0)
      * (p.cache_read_input_token_cost ?? p.input_cost_per_token);
    const cacheWriteCost = (usage.cache_creation_input_tokens ?? 0)
      * (p.cache_creation_input_token_cost ?? p.input_cost_per_token);

    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  /** 是否有定价数据 */
  get isReady(): boolean {
    return this.pricing.size > 0;
  }

  /** 查找模型定价：精确 → 带 provider 前缀 → 子串 */
  private getPricing(model: string): ModelPricing | null {
    if (this.pricing.has(model)) return this.pricing.get(model)!;

    const prefixed = `anthropic/${model}`;
    if (this.pricing.has(prefixed)) return this.pricing.get(prefixed)!;

    // 子串匹配（兜底）
    for (const [key, value] of this.pricing) {
      if (key.includes(model) || model.includes(key)) return value;
    }

    return null;
  }

  private async fetchAndCache(): Promise<void> {
    try {
      const res = await fetch(LITELLM_URL);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json() as Record<string, any>;

      this.pricing.clear();
      for (const [key, value] of Object.entries(json)) {
        if (
          (key.includes('claude') || key.startsWith('anthropic/'))
          && value.input_cost_per_token != null
        ) {
          this.pricing.set(key, {
            input_cost_per_token: value.input_cost_per_token,
            output_cost_per_token: value.output_cost_per_token,
            cache_read_input_token_cost: value.cache_read_input_token_cost,
            cache_creation_input_token_cost: value.cache_creation_input_token_cost,
          });
        }
      }

      // 写入缓存文件
      const cacheDir = dirname(CACHE_FILE);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({ fetchedAt: Date.now(), models: Object.fromEntries(this.pricing) }),
      );

      this.lastFetchAt = Date.now();
      logger.info(`[PricingService] Fetched ${this.pricing.size} Claude models`);
    } catch (e: any) {
      logger.warn(`[PricingService] Failed to fetch pricing: ${e.message}`);
    }
  }

  private loadFromCache(): boolean {
    try {
      const raw = readFileSync(CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw) as { fetchedAt: number; models: Record<string, ModelPricing> };
      this.pricing = new Map(Object.entries(data.models));
      this.lastFetchAt = data.fetchedAt;
      return true;
    } catch {
      return false;
    }
  }
}
