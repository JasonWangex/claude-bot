import useSWR from 'swr';
import { apiFetch, apiPost, apiPatch } from '@/lib/api';
import type { Goal, GoalStatus, GoalType, GoalDriveState, GoalTimelineEvent } from '@/lib/types';

export function useGoals(status?: string) {
  const params = status ? `?status=${status}` : '';
  return useSWR<Goal[]>(`/api/goals${params}`, apiFetch, {
    refreshInterval: 5000,
  });
}

export function useGoal(goalId: string | null) {
  return useSWR<Goal>(
    goalId ? `/api/goals/${goalId}` : null,
    apiFetch,
    { refreshInterval: 5000 }
  );
}

export function useGoalDrive(goalId: string | null) {
  return useSWR<GoalDriveState>(
    goalId ? `/api/goals/${goalId}/status` : null,
    apiFetch,
    { refreshInterval: 3000 }
  );
}

export async function pauseDrive(goalId: string) {
  return apiPost(`/api/goals/${goalId}/pause`);
}

export async function resumeDrive(goalId: string) {
  return apiPost(`/api/goals/${goalId}/resume`);
}

export async function skipTask(goalId: string, taskId: string) {
  return apiPost(`/api/goals/${goalId}/tasks/${taskId}/skip`);
}

export async function retryTask(goalId: string, taskId: string) {
  return apiPost(`/api/goals/${goalId}/tasks/${taskId}/retry`);
}

export async function markTaskDone(goalId: string, taskId: string) {
  return apiPost(`/api/goals/${goalId}/tasks/${taskId}/done`);
}

export async function pauseGoalTask(goalId: string, taskId: string) {
  return apiPost(`/api/goals/${goalId}/tasks/${taskId}/pause`);
}

export async function resumeGoalTask(goalId: string, taskId: string) {
  return apiPost(`/api/goals/${goalId}/tasks/${taskId}/retry`);
}

export interface CreateGoalData {
  name: string;
  status?: GoalStatus;
  type?: GoalType;
  project?: string;
  completion?: string;
  body?: string;
}

export async function createGoal(data: CreateGoalData) {
  return apiPost<Goal>('/api/goals', data);
}

export interface UpdateGoalData {
  name?: string;
  status?: GoalStatus;
  type?: GoalType;
  project?: string;
  completion?: string;
  body?: string;
}

export async function updateGoal(goalId: string, data: UpdateGoalData) {
  return apiPatch<Goal>(`/api/goals/${goalId}`, data);
}

export function useGoalTimeline(goalId: string | null) {
  return useSWR<GoalTimelineEvent[]>(
    goalId ? `/api/goals/${goalId}/timeline` : null,
    apiFetch,
    { refreshInterval: 5000 },
  );
}
