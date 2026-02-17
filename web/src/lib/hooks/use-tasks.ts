import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import type { TaskSummary, TaskDetail, SystemStatus } from '@/lib/types';

export function useTasks(status?: 'active' | 'all') {
  const query = status && status !== 'active' ? `?status=${status}` : '';
  return useSWR<TaskSummary[]>(`/api/tasks${query}`, apiFetch, {
    refreshInterval: 5000,
  });
}

export function useTask(channelId: string | null) {
  return useSWR<TaskDetail>(
    channelId ? `/api/tasks/${channelId}` : null,
    apiFetch,
    { refreshInterval: 5000 }
  );
}

export function useSystemStatus() {
  return useSWR<SystemStatus>('/api/status', apiFetch, {
    refreshInterval: 5000,
  });
}
