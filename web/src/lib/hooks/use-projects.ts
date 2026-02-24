import useSWR from 'swr';
import { apiFetch } from '@/lib/api';

export interface ProjectInfo {
  name: string;
  /** 完整磁盘路径（projectsRoot + '/' + name） */
  full_path: string;
  guild_id: string | null;
  category_id: string | null;
  channel_id: string | null;
  created_at: number;
  updated_at: number;
}

export function useProjects() {
  return useSWR<ProjectInfo[]>('/api/projects', apiFetch);
}
