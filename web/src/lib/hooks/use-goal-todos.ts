import useSWR from 'swr';
import { apiFetch, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type { GoalTodo } from '@/lib/types';

export function useGoalTodos(goalId: string | null) {
  return useSWR<GoalTodo[]>(
    goalId ? `/api/goals/${goalId}/todos` : null,
    apiFetch,
    { refreshInterval: 5000 }
  );
}

export async function addGoalTodo(goalId: string, content: string, source?: string) {
  return apiPost<GoalTodo>(`/api/goals/${goalId}/todos`, { content, source });
}

export async function toggleGoalTodo(goalId: string, todoId: string, done: boolean) {
  return apiPatch<GoalTodo>(`/api/goals/${goalId}/todos/${todoId}`, { done });
}

export async function deleteGoalTodo(goalId: string, todoId: string) {
  return apiDelete(`/api/goals/${goalId}/todos/${todoId}`);
}
