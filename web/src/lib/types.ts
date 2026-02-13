// Goal 元数据
export type GoalStatus = 'Idea' | 'Processing' | 'Active' | 'Paused' | 'Done' | 'Abandoned';
export type GoalType = '探索型' | '交付型';

export interface Goal {
  id: string;
  name: string;
  status: GoalStatus;
  type: GoalType | null;
  project: string | null;
  date: string | null;
  completion: string | null;
  progress: string | null;
  next: string | null;
  blocked_by: string | null;
  body: string | null;
}

// Goal Drive
export type GoalDriveStatus = 'running' | 'paused' | 'completed' | 'failed';
export type GoalTaskStatus = 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'blocked' | 'blocked_feedback' | 'paused' | 'cancelled' | 'skipped';
export type GoalTaskType = '代码' | '手动' | '调研' | '占位';

export interface GoalTaskFeedback {
  type: string;
  reason: string;
  details?: string;
}

export interface GoalTask {
  id: string;
  description: string;
  type: GoalTaskType;
  depends: string[];
  phase?: number;
  status: GoalTaskStatus;
  branchName?: string;
  threadId?: string;
  dispatchedAt?: number;
  completedAt?: number;
  error?: string;
  merged?: boolean;
  notifiedBlocked?: boolean;
  feedback?: GoalTaskFeedback;
}

export interface PendingReplan {
  changes: Array<Record<string, unknown>>;
  reasoning: string;
  impactLevel: 'low' | 'medium' | 'high';
  checkpointId: string;
}

export interface PendingRollback {
  checkpointId: string;
  pausedTaskIds: string[];
  costSummary: string;
  affectedTasks: Array<{
    id: string;
    description: string;
    previousStatus: GoalTaskStatus;
    runtime?: number;
    diffStat?: string;
  }>;
  createdAt: number;
}

export interface GoalDriveState {
  goalId: string;
  goalName: string;
  goalBranch: string;
  goalThreadId: string;
  baseCwd: string;
  status: GoalDriveStatus;
  createdAt: number;
  updatedAt: number;
  maxConcurrent: number;
  tasks: GoalTask[];
  pendingReplan?: PendingReplan;
  pendingRollback?: PendingRollback;
}

// Session / Task
export interface TaskSummary {
  thread_id: string;
  name: string;
  cwd: string;
  model: string | null;
  has_session: boolean;
  message_count: number;
  created_at: number;
  last_message: string | null;
  last_message_at: number | null;
  parent_thread_id: string | null;
  worktree_branch: string | null;
  children: TaskSummary[];
}

export interface TaskDetail extends TaskSummary {
  claude_session_id: string | null;
  plan_mode: boolean;
  message_history: Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
}

// DevLog
export interface DevLog {
  id: string;
  name: string;
  date: string;
  project: string;
  branch: string;
  summary: string;
  commits: number;
  lines_changed: string;
  goal?: string;
  content?: string;
  created_at: number;
}

// Idea
export type IdeaStatus = 'Idea' | 'Processing' | 'Active' | 'Paused' | 'Done' | 'Dropped';

export interface Idea {
  id: string;
  name: string;
  status: IdeaStatus;
  project: string;
  date: string;
  created_at: number;
  updated_at: number;
}

// System status
export interface SystemStatus {
  default_cwd: string;
  default_model: string | null;
  active_tasks: number;
  tasks: TaskSummary[];
}
