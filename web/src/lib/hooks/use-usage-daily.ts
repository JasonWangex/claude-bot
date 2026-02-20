import useSWR from 'swr';
import { apiFetch } from '@/lib/api';

export interface DailyUsage {
  date: string;
  session_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_in: number;
  cache_write_in: number;
  cost_usd: number;
  turn_count: number;
}

export function useUsageDaily(days = 7) {
  return useSWR<DailyUsage[]>(
    `/api/sessions/usage/daily?days=${days}`,
    apiFetch,
    { refreshInterval: 30000 },
  );
}
