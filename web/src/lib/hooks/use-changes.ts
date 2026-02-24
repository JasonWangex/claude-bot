import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import type { SessionChangesPage, SessionChangesDetail } from '@/lib/types';

export function useChannelChanges(channelId: string | null, page = 1, size = 20) {
  return useSWR<SessionChangesPage>(
    channelId ? `/api/channels/${channelId}/changes?page=${page}&size=${size}` : null,
    apiFetch,
  );
}

export function useChangesDetail(id: number | null) {
  return useSWR<SessionChangesDetail>(
    id != null ? `/api/changes/${id}` : null,
    apiFetch,
  );
}
