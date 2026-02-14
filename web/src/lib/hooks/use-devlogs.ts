import useSWR from 'swr';
import { apiFetch, apiPost } from '@/lib/api';
import type { DevLog } from '@/lib/types';

export function useDevLogs() {
  return useSWR<DevLog[]>('/api/devlogs', apiFetch, {
    refreshInterval: 10000,
  });
}

export interface CreateDevLogData {
  name: string;
  date: string;
  project: string;
  branch?: string;
  summary?: string;
  commits?: number;
  lines_changed?: string;
  goal?: string;
  content?: string;
}

export async function createDevLog(data: CreateDevLogData) {
  return apiPost<DevLog>('/api/devlogs', data);
}
