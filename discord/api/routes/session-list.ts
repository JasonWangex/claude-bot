/**
 * Session List API
 *
 * GET /api/sessions           — 列出所有 claude sessions（支持分页、状态和 goal 过滤）
 * GET /api/sessions/:id/meta  — 获取单个 session 元数据（含 context）
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';

// JOIN 查询结果行类型
interface SessionListRow {
  claude_session_id: string;
  channel_id: string | null;
  model: string | null;
  plan_mode: number;
  status: string;
  purpose: string | null;
  title: string | null;
  created_at: number;
  closed_at: number | null;
  last_activity_at: number | null;
  task_id: string | null;
  goal_id: string | null;
  cwd: string | null;
  git_branch: string | null;
  project_path: string | null;
  // usage 字段
  tokens_in: number;
  tokens_out: number;
  cache_read_in: number;
  cache_write_in: number;
  cost_usd: number;
  turn_count: number;
  model_usage: string | null;
  // JOIN 字段
  channel_name: string | null;
  task_description: string | null;
  pipeline_phase: string | null;
  goal_name: string | null;
  goal_project: string | null;
}

export const listSessions: RouteHandler = async (req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const statusFilter = url.searchParams.get('status') || 'all';
  const goalIdFilter = url.searchParams.get('goal_id') || null;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 2000);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

  // 构建动态 WHERE 子句
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (statusFilter === 'active') {
    conditions.push('cs.status = ?');
    params.push('active');
  } else if (statusFilter === 'closed') {
    conditions.push('cs.status = ?');
    params.push('closed');
  }

  if (goalIdFilter) {
    conditions.push('cs.goal_id = ?');
    params.push(goalIdFilter);
  }

  const whereClause = conditions.length > 0
    ? 'WHERE ' + conditions.join(' AND ')
    : '';

  try {
    // COUNT 查询
    const countSql = `SELECT COUNT(*) as total FROM claude_sessions cs ${whereClause}`;
    const countRow = deps.db.prepare(countSql).get(...params) as { total: number };
    const total = countRow.total;

    // 数据查询（JOIN task/goal/channel）
    const dataSql = `
      SELECT cs.claude_session_id, cs.channel_id, cs.model, cs.plan_mode,
             cs.status, cs.purpose, cs.title, cs.created_at, cs.closed_at,
             cs.last_activity_at, cs.task_id, cs.goal_id, cs.cwd, cs.git_branch, cs.project_path,
             cs.tokens_in, cs.tokens_out, cs.cache_read_in, cs.cache_write_in,
             cs.cost_usd, cs.turn_count, cs.model_usage,
             ch.name AS channel_name,
             t.description AS task_description,
             t.pipeline_phase,
             g.name AS goal_name,
             g.project AS goal_project
      FROM claude_sessions cs
      LEFT JOIN channels ch ON cs.channel_id = ch.id
      LEFT JOIN tasks t ON cs.task_id = t.id
      LEFT JOIN goals g ON cs.goal_id = g.id
      ${whereClause}
      ORDER BY COALESCE(cs.last_activity_at, cs.created_at) DESC
      LIMIT ? OFFSET ?
    `;

    const rows = deps.db.prepare(dataSql).all(...params, limit, offset) as SessionListRow[];

    const data = rows.map(r => ({
      claude_session_id: r.claude_session_id,
      channel_id: r.channel_id,
      channel_name: r.channel_name,
      model: r.model,
      status: r.status,
      purpose: r.purpose,
      title: r.title,
      created_at: r.created_at,
      closed_at: r.closed_at,
      last_activity_at: r.last_activity_at,
      task_id: r.task_id,
      goal_id: r.goal_id,
      task_description: r.task_description,
      pipeline_phase: r.pipeline_phase,
      goal_name: r.goal_name,
      goal_project: r.goal_project,
      cwd: r.cwd,
      git_branch: r.git_branch,
      project_path: r.project_path,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
      cache_read_in: r.cache_read_in,
      cache_write_in: r.cache_write_in,
      cost_usd: r.cost_usd,
      turn_count: r.turn_count,
      model_usage: r.model_usage ? JSON.parse(r.model_usage) : null,
    }));

    sendJson(res, 200, { ok: true, data, total, limit, offset });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list sessions: ${error.message}` });
  }
};

// GET /api/sessions/:id/meta
export const getSessionMeta: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const sessionId = params.id;
  if (!sessionId) {
    sendJson(res, 400, { ok: false, error: 'Session ID required' });
    return;
  }

  try {
    const sql = `
      SELECT cs.claude_session_id, cs.channel_id, cs.model, cs.plan_mode,
             cs.status, cs.purpose, cs.title, cs.created_at, cs.closed_at,
             cs.last_activity_at, cs.task_id, cs.goal_id, cs.cwd, cs.git_branch, cs.project_path,
             cs.tokens_in, cs.tokens_out, cs.cache_read_in, cs.cache_write_in,
             cs.cost_usd, cs.turn_count, cs.model_usage,
             ch.name AS channel_name,
             t.description AS task_description,
             t.pipeline_phase,
             g.name AS goal_name,
             g.project AS goal_project
      FROM claude_sessions cs
      LEFT JOIN channels ch ON cs.channel_id = ch.id
      LEFT JOIN tasks t ON cs.task_id = t.id
      LEFT JOIN goals g ON cs.goal_id = g.id
      WHERE cs.claude_session_id = ?
    `;

    const row = deps.db.prepare(sql).get(sessionId) as SessionListRow | undefined;
    if (!row) {
      sendJson(res, 404, { ok: false, error: 'Session not found' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      data: {
        claude_session_id: row.claude_session_id,
        channel_id: row.channel_id,
        channel_name: row.channel_name,
        model: row.model,
        status: row.status,
        purpose: row.purpose,
        title: row.title,
        created_at: row.created_at,
        closed_at: row.closed_at,
        last_activity_at: row.last_activity_at,
        task_id: row.task_id,
        goal_id: row.goal_id,
        task_description: row.task_description,
        pipeline_phase: row.pipeline_phase,
        goal_name: row.goal_name,
        goal_project: row.goal_project,
        cwd: row.cwd,
        git_branch: row.git_branch,
        project_path: row.project_path,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        cache_read_in: row.cache_read_in,
        cache_write_in: row.cache_write_in,
        cost_usd: row.cost_usd,
        turn_count: row.turn_count,
        model_usage: row.model_usage ? JSON.parse(row.model_usage) : null,
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get session meta: ${error.message}` });
  }
};
