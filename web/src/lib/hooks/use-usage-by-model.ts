import useSWR from 'swr';
import { apiFetch } from '@/lib/api';

export interface ModelUsage {
  model: string;
  session_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_in: number;
  cache_write_in: number;
  cost_usd: number;
  turn_count: number;
}

export function useUsageByModel(days = 7) {
  return useSWR<ModelUsage[]>(
    `/api/sessions/usage/by-model?days=${days}`,
    apiFetch,
    { refreshInterval: 30000 },
  );
}
