/**
 * Goal Todo CRUD 路由
 *
 * GET    /api/goals/:goalId/todos            — 列出 Goal 的待办事项
 * POST   /api/goals/:goalId/todos            — 创建待办事项
 * PATCH  /api/goals/:goalId/todos/:todoId    — 更新待办事项（内容、状态）
 * DELETE /api/goals/:goalId/todos/:todoId    — 删除待办事项
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb, GoalTodoRepository } from '../../db/index.js';
import type { GoalTodo, GoalTodoPriority } from '../../types/repository.js';

const VALID_PRIORITIES: GoalTodoPriority[] = ['重要', '高', '中', '低'];

function getRepo() {
  return new GoalTodoRepository(getDb());
}

/** GoalTodo → API 响应格式 (snake_case) */
function toApiTodo(todo: GoalTodo) {
  return {
    id: todo.id,
    goal_id: todo.goalId,
    content: todo.content,
    done: todo.done,
    source: todo.source,
    priority: todo.priority,
    created_at: todo.createdAt,
    updated_at: todo.updatedAt,
  };
}

// GET /api/goals/:goalId/todos
export const listGoalTodos: RouteHandler = async (_req, res, params) => {
  try {
    const repo = getRepo();
    const todos = await repo.findByGoal(params.goalId);
    sendJson(res, 200, { ok: true, data: todos.map(toApiTodo) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list todos: ${error.message}` });
  }
};

interface CreateTodoRequest {
  content: string;
  source?: string;
  priority?: GoalTodoPriority;
}

// POST /api/goals/:goalId/todos
export const createGoalTodo: RouteHandler = async (req, res, params) => {
  const body = await readJsonBody<CreateTodoRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  if (!body.content || typeof body.content !== 'string') {
    sendJson(res, 400, { ok: false, error: '"content" field is required' });
    return;
  }

  const priority: GoalTodoPriority = VALID_PRIORITIES.includes(body.priority as GoalTodoPriority)
    ? (body.priority as GoalTodoPriority)
    : '中';

  try {
    const repo = getRepo();
    const now = Date.now();
    const id = `todo-${now}-${Math.random().toString(36).slice(2, 8)}`;

    const todo: GoalTodo = {
      id,
      goalId: params.goalId,
      content: body.content.trim(),
      done: false,
      source: body.source?.trim() || null,
      priority,
      createdAt: now,
      updatedAt: now,
    };

    await repo.save(todo);
    sendJson(res, 201, { ok: true, data: toApiTodo(todo) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create todo: ${error.message}` });
  }
};

interface UpdateTodoRequest {
  content?: string;
  done?: boolean;
  priority?: GoalTodoPriority;
}

// PATCH /api/goals/:goalId/todos/:todoId
export const updateGoalTodo: RouteHandler = async (req, res, params) => {
  const body = await readJsonBody<UpdateTodoRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  try {
    const repo = getRepo();
    const todo = await repo.get(params.todoId);
    if (!todo) {
      sendJson(res, 404, { ok: false, error: 'Todo not found' });
      return;
    }

    if (body.content !== undefined) todo.content = body.content.trim();
    if (body.done !== undefined) todo.done = body.done;
    if (body.priority !== undefined && VALID_PRIORITIES.includes(body.priority)) todo.priority = body.priority;
    todo.updatedAt = Date.now();

    await repo.save(todo);
    sendJson(res, 200, { ok: true, data: toApiTodo(todo) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to update todo: ${error.message}` });
  }
};

// DELETE /api/goals/:goalId/todos/:todoId
export const deleteGoalTodo: RouteHandler = async (_req, res, params) => {
  try {
    const repo = getRepo();
    const deleted = await repo.delete(params.todoId);
    if (!deleted) {
      sendJson(res, 404, { ok: false, error: 'Todo not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: { deleted: true } });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to delete todo: ${error.message}` });
  }
};
