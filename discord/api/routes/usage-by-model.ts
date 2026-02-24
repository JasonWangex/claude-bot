/**
 * Usage By Model API
 *
 * GET /api/sessions/usage/by-model  — 最近 N 天按模型聚合的 usage 统计
 *
 * 优先使用 model_usage JSON（每个 session 内的分模型明细），
 * 无 model_usage 时回退到 session 级别的 model 字段。
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';

interface SessionRow {
  model: string | null;
  model_usage: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_in: number;
  cache_write_in: number;
  cost_usd: number;
  turn_count: number;
}

interface ModelStats {
  tokensIn: number;
  tokensOut: number;
  cacheReadIn: number;
  cacheWriteIn: number;
  costUsd: number;
  turnCount: number;
}

interface ModelAgg {
  session_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_in: number;
  cache_write_in: number;
  cost_usd: number;
  turn_count: number;
}

function emptyAgg(): ModelAgg {
  return { session_count: 0, tokens_in: 0, tokens_out: 0, cache_read_in: 0, cache_write_in: 0, cost_usd: 0, turn_count: 0 };
}

export const getUsageByModel: RouteHandler = async (req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 90);

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (days - 1));
    const startDateStr = startDate.toISOString().slice(0, 10);

    const sql = `
      SELECT
        model, model_usage,
        COALESCE(tokens_in, 0) AS tokens_in,
        COALESCE(tokens_out, 0) AS tokens_out,
        COALESCE(cache_read_in, 0) AS cache_read_in,
        COALESCE(cache_write_in, 0) AS cache_write_in,
        COALESCE(cost_usd, 0) AS cost_usd,
        COALESCE(turn_count, 0) AS turn_count
      FROM claude_sessions
      WHERE date(created_at / 1000, 'unixepoch', 'localtime') >= ?
        AND (hidden IS NULL OR hidden = 0)
    `;

    const rows = deps.db.prepare(sql).all(startDateStr) as SessionRow[];

    // 按模型聚合，优先使用 model_usage JSON 分项
    const modelMap = new Map<string, ModelAgg>();

    for (const row of rows) {
      if (row.model_usage) {
        try {
          const usage = JSON.parse(row.model_usage) as Record<string, ModelStats>;
          const entries = Object.entries(usage);
          if (entries.length > 0) {
            for (const [modelName, stats] of entries) {
              const agg = modelMap.get(modelName) ?? emptyAgg();
              agg.session_count++;
              agg.tokens_in += stats.tokensIn ?? 0;
              agg.tokens_out += stats.tokensOut ?? 0;
              agg.cache_read_in += stats.cacheReadIn ?? 0;
              agg.cache_write_in += stats.cacheWriteIn ?? 0;
              agg.cost_usd += stats.costUsd ?? 0;
              agg.turn_count += stats.turnCount ?? 0;
              modelMap.set(modelName, agg);
            }
            continue;
          }
          // 空对象 {} — fall through 到 session-level 回退
        } catch {
          // JSON 解析失败，fall through 到 session-level 回退
        }
      }

      // 回退：使用 session 级别数据和 model 字段
      const modelName = row.model ?? 'unknown';
      const agg = modelMap.get(modelName) ?? emptyAgg();
      agg.session_count++;
      agg.tokens_in += row.tokens_in;
      agg.tokens_out += row.tokens_out;
      agg.cache_read_in += row.cache_read_in;
      agg.cache_write_in += row.cache_write_in;
      agg.cost_usd += row.cost_usd;
      agg.turn_count += row.turn_count;
      modelMap.set(modelName, agg);
    }

    const data = Array.from(modelMap.entries())
      .map(([model, agg]) => ({ model, ...agg }))
      .sort((a, b) => b.cost_usd - a.cost_usd);

    sendJson(res, 200, { ok: true, data });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get model usage: ${error.message}` });
  }
};
