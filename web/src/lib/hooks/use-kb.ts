import useSWR from 'swr';
import { apiFetch, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type { KnowledgeBaseEntry } from '@/lib/types';

export function useKnowledgeBase(project?: string, category?: string) {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  if (category) params.set('category', category);
  const qs = params.toString();
  return useSWR<KnowledgeBaseEntry[]>(
    `/api/kb${qs ? `?${qs}` : ''}`,
    apiFetch,
    { refreshInterval: 10000 },
  );
}

export interface CreateKBData {
  title: string;
  content: string;
  project: string;
  category?: string;
  tags?: string[];
  source?: string;
}

export async function createKB(data: CreateKBData) {
  return apiPost<KnowledgeBaseEntry>('/api/kb', data);
}

export interface UpdateKBData {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  project?: string;
  source?: string;
}

export async function updateKB(id: string, data: UpdateKBData) {
  return apiPatch<KnowledgeBaseEntry>(`/api/kb/${id}`, data);
}

export async function deleteKB(id: string) {
  return apiDelete(`/api/kb/${id}`);
}
