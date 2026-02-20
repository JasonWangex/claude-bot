import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import type { ChannelSummary, ChannelDetail, SystemStatus } from '@/lib/types';

export function useChannels(status?: 'active' | 'all') {
  const query = status && status !== 'active' ? `?status=${status}` : '';
  return useSWR<ChannelSummary[]>(`/api/channels${query}`, apiFetch, {
    refreshInterval: 5000,
  });
}

export function useChannel(channelId: string | null) {
  return useSWR<ChannelDetail>(
    channelId ? `/api/channels/${channelId}` : null,
    apiFetch,
    { refreshInterval: 5000 }
  );
}

export function useSystemStatus() {
  return useSWR<SystemStatus>('/api/status', apiFetch, {
    refreshInterval: 5000,
  });
}
