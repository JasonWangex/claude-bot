import useSWR from 'swr';
import { apiFetch, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type { Idea, IdeaStatus } from '@/lib/types';

export function useIdeas() {
  return useSWR<Idea[]>('/api/ideas', apiFetch, {
    refreshInterval: 10000,
  });
}

export function useIdea(id: string | null) {
  return useSWR<Idea>(id ? `/api/ideas/${id}` : null, apiFetch);
}

export async function createIdea(data: { name: string; project: string; status?: IdeaStatus; body?: string }) {
  return apiPost<Idea>('/api/ideas', data);
}

export async function updateIdea(id: string, data: { name?: string; status?: IdeaStatus; project?: string; body?: string | null }) {
  return apiPatch<Idea>(`/api/ideas/${id}`, data);
}

export async function deleteIdea(id: string) {
  return apiDelete(`/api/ideas/${id}`);
}
