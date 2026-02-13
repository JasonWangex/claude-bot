'use client';

import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import type { DevLog } from '@/lib/types';

export function useDevLogs() {
  return useSWR<DevLog[]>('/api/devlogs', apiFetch, {
    refreshInterval: 10000,
  });
}
