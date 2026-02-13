import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import type { TaskSummary, TaskDetail, SystemStatus, InteractionLogResponse } from '@/lib/types';

export function useTasks() {
  return useSWR<TaskSummary[]>('/api/tasks', apiFetch, {
    refreshInterval: 5000,
  });
}

export function useTask(threadId: string | null) {
  return useSWR<TaskDetail>(
    threadId ? `/api/tasks/${threadId}` : null,
    apiFetch,
    { refreshInterval: 5000 }
  );
}

export function useTaskInteractions(threadId: string | null) {
  return useSWR<InteractionLogResponse>(
    threadId ? `/api/tasks/${threadId}/interactions` : null,
    apiFetch,
    { refreshInterval: 10000 }
  );
}

export function useSystemStatus() {
  return useSWR<SystemStatus>('/api/status', apiFetch, {
    refreshInterval: 5000,
  });
}
