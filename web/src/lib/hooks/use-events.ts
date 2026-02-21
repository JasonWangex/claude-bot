import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import type { TaskEventPage } from '@/lib/types';

export interface UseEventsOptions {
  goalId?: string;
  taskId?: string;
  type?: string;
  pending?: boolean;
  page?: number;
  size?: number;
}

function buildUrl(opts?: UseEventsOptions) {
  const params = new URLSearchParams();
  if (opts?.goalId) params.set('goalId', opts.goalId);
  if (opts?.taskId) params.set('taskId', opts.taskId);
  if (opts?.type) params.set('type', opts.type);
  if (opts?.pending) params.set('pending', 'true');
  if (opts?.page) params.set('page', String(opts.page));
  if (opts?.size) params.set('size', String(opts.size));
  const qs = params.toString();
  return qs ? `/api/events?${qs}` : '/api/events';
}

export function useEvents(opts?: UseEventsOptions) {
  return useSWR<TaskEventPage>(buildUrl(opts), apiFetch, {
    refreshInterval: 5000,
  });
}
