/**
 * Prompt 配置 Service
 *
 * 提供内存缓存、模板渲染和启动校验功能。
 * 启动时从数据库加载全部 prompt 配置到 Map 缓存，
 * 运行时通过 render() 获取并填充模板变量。
 */

import type { IPromptConfigRepo, PromptConfig } from '../types/repository.js';
import { logger } from '../utils/logger.js';

/** 代码声明需要的 prompt 和变量 */
export interface PromptRequirement {
  key: string;
  variables: string[];
  /** section 类型通常为 optional */
  optional?: boolean;
}

export class PromptConfigService {
  private cache = new Map<string, PromptConfig>();

  constructor(private repo: IPromptConfigRepo) {}

  /** 启动时加载全部到缓存 */
  async loadAll(): Promise<void> {
    const all = await this.repo.getAll();
    this.cache.clear();
    for (const config of all) {
      this.cache.set(config.key, config);
    }
    logger.info(`[PromptConfig] Loaded ${this.cache.size} prompt configs`);
  }

  /** 刷新缓存（API 调用） */
  async refresh(): Promise<{ count: number }> {
    await this.loadAll();
    return { count: this.cache.size };
  }

  /** 获取单个 PromptConfig */
  get(key: string): PromptConfig | null {
    return this.cache.get(key) ?? null;
  }

  /** 获取所有缓存的配置 */
  getAll(): PromptConfig[] {
    return Array.from(this.cache.values());
  }

  /** 获取模板文本 */
  getTemplate(key: string): string | null {
    return this.cache.get(key)?.template ?? null;
  }

  /** 渲染模板：替换 {{VAR}} 变量 */
  render(key: string, vars: Record<string, string> = {}): string {
    const template = this.getTemplate(key);
    if (!template) throw new Error(`Prompt config not found: ${key}`);
    return this.applyVars(template, vars);
  }

  /** 尝试渲染，不存在时返回 null */
  tryRender(key: string, vars: Record<string, string> = {}): string | null {
    const template = this.getTemplate(key);
    if (!template) return null;
    return this.applyVars(template, vars);
  }

  /** 更新单条 prompt 配置并刷新缓存 */
  async update(key: string, updates: { template?: string; variables?: string[]; name?: string; description?: string }): Promise<PromptConfig | null> {
    const config = this.cache.get(key);
    if (!config) return null;

    if (updates.template !== undefined) config.template = updates.template;
    if (updates.variables !== undefined) config.variables = updates.variables;
    if (updates.name !== undefined) config.name = updates.name;
    if (updates.description !== undefined) config.description = updates.description;
    config.updatedAt = Date.now();

    await this.repo.save(config);
    this.cache.set(key, config);
    return config;
  }

  /** 对给定模板文本应用变量替换 */
  applyVars(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return vars[name] !== undefined ? vars[name] : match;
    });
  }

  /**
   * 启动校验：检查所有必需 prompt 是否存在 + 变量匹配
   */
  validate(requirements: PromptRequirement[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const req of requirements) {
      const config = this.cache.get(req.key);

      if (!config) {
        if (!req.optional) {
          errors.push(`Missing required prompt: ${req.key}`);
        }
        continue;
      }

      // 代码期望的变量，数据库模板必须声明
      const dbVars = new Set(config.variables);
      for (const v of req.variables) {
        if (!dbVars.has(v)) {
          errors.push(`Prompt "${req.key}": code expects variable {{${v}}} but DB does not declare it`);
        }
      }

      // 数据库声明但代码没用的变量（仅警告）
      const codeVars = new Set(req.variables);
      for (const v of dbVars) {
        if (!codeVars.has(v)) {
          logger.warn(`[PromptConfig] Prompt "${req.key}": DB declares {{${v}}} but code does not expect it`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
