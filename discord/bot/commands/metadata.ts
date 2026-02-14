/**
 * Command 元数据定义
 * 为每个 Discord Slash Command 提供描述、分组、使用示例等信息
 */

export interface CommandMeta {
  /** 命令名称 */
  name: string;
  /** 命令描述 */
  description: string;
  /** 命令分组 */
  category: 'General' | 'Task' | 'Session' | 'Model' | 'Dev' | 'Goal';
  /** 参数列表 */
  parameters?: CommandParameter[];
  /** 使用示例 */
  examples?: string[];
  /** 使用场景 */
  context?: 'general' | 'task_only' | 'any';
  /** 是否需要认证 */
  requiresAuth?: boolean;
}

export interface CommandParameter {
  /** 参数名 */
  name: string;
  /** 参数类型 */
  type: 'string' | 'boolean' | 'integer';
  /** 是否必需 */
  required: boolean;
  /** 参数描述 */
  description: string;
}

/**
 * 所有命令的元数据
 */
export const COMMAND_METADATA: CommandMeta[] = [
  // ========== General 命令 ==========
  {
    name: 'login',
    description: '绑定 Bot 到此 Server',
    category: 'General',
    context: 'general',
    requiresAuth: false,
    parameters: [
      {
        name: 'token',
        type: 'string',
        required: true,
        description: '访问令牌',
      },
    ],
    examples: ['/login token:YOUR_ACCESS_TOKEN'],
  },
  {
    name: 'start',
    description: '显示欢迎信息和使用说明',
    category: 'General',
    context: 'any',
    requiresAuth: true,
    examples: ['/start'],
  },
  {
    name: 'help',
    description: '查看完整帮助',
    category: 'General',
    context: 'any',
    requiresAuth: true,
    examples: ['/help'],
  },
  {
    name: 'status',
    description: '查看全局状态',
    category: 'General',
    context: 'any',
    requiresAuth: true,
    examples: ['/status'],
  },

  // ========== Task 命令 ==========
  {
    name: 'task',
    description: '创建新任务（在 Category 下创建 Text Channel）',
    category: 'Task',
    context: 'general',
    requiresAuth: true,
    parameters: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: '任务名称',
      },
      {
        name: 'path',
        type: 'string',
        required: false,
        description: '自定义工作目录路径',
      },
      {
        name: 'category',
        type: 'string',
        required: false,
        description: 'Category 名称（默认为仓库名）',
      },
    ],
    examples: [
      '/task name:"Fix login bug"',
      '/task name:"Add feature" path:/custom/path',
      '/task name:"Update docs" category:Documentation',
    ],
  },
  {
    name: 'close',
    description: '关闭当前 task channel 并清理 worktree/分支',
    category: 'Task',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'force',
        type: 'boolean',
        required: false,
        description: '强制关闭（跳过安全检查）',
      },
    ],
    examples: ['/close', '/close force:true'],
  },
  {
    name: 'info',
    description: '查看当前频道详情或服务器信息',
    category: 'Task',
    context: 'any',
    requiresAuth: true,
    examples: ['/info'],
  },
  {
    name: 'cd',
    description: '切换或查看工作目录',
    category: 'Task',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: '新的工作目录路径',
      },
    ],
    examples: ['/cd', '/cd path:/home/user/project'],
  },

  // ========== Session 命令 ==========
  {
    name: 'clear',
    description: '清除 Claude 会话上下文',
    category: 'Session',
    context: 'task_only',
    requiresAuth: true,
    examples: ['/clear'],
  },
  {
    name: 'compact',
    description: '压缩 Claude 会话上下文',
    category: 'Session',
    context: 'task_only',
    requiresAuth: true,
    examples: ['/compact'],
  },
  {
    name: 'rewind',
    description: '撤销上一轮对话',
    category: 'Session',
    context: 'task_only',
    requiresAuth: true,
    examples: ['/rewind'],
  },
  {
    name: 'plan',
    description: '发送计划模式消息（仅规划，不执行）',
    category: 'Session',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'message',
        type: 'string',
        required: true,
        description: '要在计划模式下发送的消息',
      },
    ],
    examples: ['/plan message:"How should I implement user authentication?"'],
  },
  {
    name: 'stop',
    description: '停止当前运行的 Claude 任务',
    category: 'Session',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'message',
        type: 'string',
        required: false,
        description: '停止后发送的后续消息（中断并恢复）',
      },
    ],
    examples: ['/stop', '/stop message:"Let\'s try a different approach"'],
  },
  {
    name: 'attach',
    description: '链接到特定的 Claude session',
    category: 'Session',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'session_id',
        type: 'string',
        required: false,
        description: '要附加的 Claude session ID',
      },
    ],
    examples: ['/attach', '/attach session_id:abc123'],
  },

  // ========== Model 命令 ==========
  {
    name: 'model',
    description: '切换 Claude 模型或查看可用模型',
    category: 'Model',
    context: 'any',
    requiresAuth: true,
    parameters: [
      {
        name: 'name',
        type: 'string',
        required: false,
        description: '模型名称（留空查看列表）',
      },
    ],
    examples: ['/model', '/model name:"Sonnet 4.5"'],
  },

  // ========== Dev 命令 ==========
  {
    name: 'qdev',
    description: 'Quick Dev：创建分支 + 任务 + 启动 Claude',
    category: 'Dev',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'description',
        type: 'string',
        required: true,
        description: '任务描述',
      },
    ],
    examples: ['/qdev description:"Implement dark mode toggle"'],
  },
  {
    name: 'idea',
    description: '记录想法或开发已有想法',
    category: 'Dev',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'content',
        type: 'string',
        required: false,
        description: '想法内容（留空列出现有想法）',
      },
    ],
    examples: ['/idea', '/idea content:"Add real-time notifications"'],
  },
  {
    name: 'commit',
    description: '审查并提交代码更改',
    category: 'Dev',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'message',
        type: 'string',
        required: false,
        description: '可选的提交信息提示',
      },
    ],
    examples: ['/commit', '/commit message:"Fix authentication issue"'],
  },
  {
    name: 'merge',
    description: '合并 worktree 分支到 main 并清理',
    category: 'Dev',
    context: 'general',
    requiresAuth: true,
    parameters: [
      {
        name: 'target',
        type: 'string',
        required: true,
        description: '要合并的 Thread 名称或分支名称',
      },
    ],
    examples: ['/merge target:feat-dark-mode'],
  },

  // ========== Goal 命令 ==========
  {
    name: 'goal',
    description: '管理开发目标：创建、继续或列出',
    category: 'Goal',
    context: 'task_only',
    requiresAuth: true,
    parameters: [
      {
        name: 'text',
        type: 'string',
        required: false,
        description: '目标描述或搜索名称',
      },
      {
        name: 'new_session',
        type: 'boolean',
        required: false,
        description: '执行前 fork 新会话（默认：false）',
      },
    ],
    examples: [
      '/goal',
      '/goal text:"Implement user profile page"',
      '/goal text:"Authentication" new_session:true',
    ],
  },
];

/**
 * 根据命令名称获取元数据
 */
export function getCommandMetadata(name: string): CommandMeta | undefined {
  return COMMAND_METADATA.find(cmd => cmd.name === name);
}

/**
 * 根据分类获取命令列表
 */
export function getCommandsByCategory(category: CommandMeta['category']): CommandMeta[] {
  return COMMAND_METADATA.filter(cmd => cmd.category === category);
}

/**
 * 获取所有命令分类
 */
export function getAllCategories(): CommandMeta['category'][] {
  return ['General', 'Task', 'Session', 'Model', 'Dev', 'Goal'];
}
