/**
 * Usage Daily API
 *
 * GET /api/sessions/usage/daily  — 最近 N 天按天聚合的 usage 统计
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';

interface DailyUsageRow {
  date: string;
  session_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_in: number;
  cache_write_in: number;
  cost_usd: number;
  turn_count: number;
}

export const getUsageDaily: RouteHandler = async (req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 90);

  try {
    // 计算起始日期（含当天，所以 days-1）
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (days - 1));
    const startDateStr = startDate.toISOString().slice(0, 10); // yyyy-MM-dd

    const sql = `
      SELECT
        date(created_at / 1000, 'unixepoch', 'localtime') AS date,
        COUNT(*) AS session_count,
        COALESCE(SUM(tokens_in), 0) AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cache_read_in), 0) AS cache_read_in,
        COALESCE(SUM(cache_write_in), 0) AS cache_write_in,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(turn_count), 0) AS turn_count
      FROM claude_sessions
      WHERE date(created_at / 1000, 'unixepoch', 'localtime') >= ?
      GROUP BY date(created_at / 1000, 'unixepoch', 'localtime')
      ORDER BY date ASC
    `;

    const rows = deps.db.prepare(sql).all(startDateStr) as DailyUsageRow[];

    // 构建日期 map 用于补零
    const rowMap = new Map<string, DailyUsageRow>();
    for (const row of rows) {
      rowMap.set(row.date, row);
    }

    // 生成连续日期序列并补零
    const data: DailyUsageRow[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      data.push(rowMap.get(dateStr) ?? {
        date: dateStr,
        session_count: 0,
        tokens_in: 0,
        tokens_out: 0,
        cache_read_in: 0,
        cache_write_in: 0,
        cost_usd: 0,
        turn_count: 0,
      });
    }

    sendJson(res, 200, { ok: true, data });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get daily usage: ${error.message}` });
  }
};
