'use client';

import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import type { TaskSummary, TaskDetail, SystemStatus } from '@/lib/types';

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

export function useSystemStatus() {
  return useSWR<SystemStatus>('/api/status', apiFetch, {
    refreshInterval: 5000,
  });
}
