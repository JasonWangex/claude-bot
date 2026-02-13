'use client';

import useSWR from 'swr';
import { apiFetch, apiPatch } from '@/lib/api';
import type { Idea, IdeaStatus } from '@/lib/types';

export function useIdeas() {
  return useSWR<Idea[]>('/api/ideas', apiFetch, {
    refreshInterval: 10000,
  });
}

export async function updateIdeaStatus(id: string, status: IdeaStatus) {
  return apiPatch(`/api/ideas/${id}`, { status });
}
