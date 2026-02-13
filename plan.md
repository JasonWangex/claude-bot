# Web 前端重构计划：Next.js + shadcn/ui → Vite + Ant Design

## 目标

将 `web/` 目录从 Next.js 16 + shadcn/ui + Tailwind CSS 完整迁移到 **Vite + React 19 + React Router + Ant Design 5**。

这是个人工具项目，不需要 SSR/SSG，Next.js 只增加了启动延迟和复杂度。

**包管理器：pnpm**

## 技术选型

| 维度 | 现在 | 迁移后 |
|------|------|--------|
| 构建工具 | Next.js 16 (Turbopack) | **Vite 6** |
| 路由 | Next.js App Router | **React Router 7** (SPA) |
| UI 库 | shadcn/ui + Radix UI | **Ant Design 5** |
| 样式 | Tailwind CSS v4 + CSS 变量 | **Ant Design Token + CSS Modules**（必要时） |
| 图标 | Lucide React | **@ant-design/icons** |
| 数据获取 | SWR | **SWR**（保留，与框架无关） |
| 图可视化 | @xyflow/react (ReactFlow) | **@xyflow/react**（保留） |
| 类型 | TypeScript 5.9 | **TypeScript 5.9**（保留） |
| 字体 | Geist (via next/font) | 系统默认（Ant Design 默认字体栈） |

## 需要迁移的文件清单

### 可原样保留（框架无关）
- `lib/api.ts` — 仅需删除 `NEXT_PUBLIC_` 前缀改为 `VITE_`
- `lib/types.ts` — 完全不变
- `lib/format.ts` — 完全不变
- `lib/hooks/use-goals.ts` — 删除 `'use client'` 即可
- `lib/hooks/use-tasks.ts` — 同上
- `lib/hooks/use-devlogs.ts` — 同上
- `lib/hooks/use-ideas.ts` — 同上

### 需要重写的页面（8 个）

| 现有文件 | 新文件 | 说明 |
|---------|--------|------|
| `app/layout.tsx` | `src/App.tsx` + `src/layouts/MainLayout.tsx` | Ant Design Layout + Sider |
| `app/page.tsx` | `src/pages/Dashboard.tsx` | Statistic + Card |
| `app/goals/page.tsx` | `src/pages/Goals.tsx` | Card + Select + Empty |
| `app/goals/[goalId]/page.tsx` | `src/pages/GoalDetail.tsx` | Tabs + Breadcrumb + Tag |
| `app/tasks/page.tsx` | `src/pages/Tasks.tsx` | Card |
| `app/tasks/[threadId]/page.tsx` | `src/pages/TaskDetail.tsx` | Breadcrumb + Descriptions + Card |
| `app/devlogs/page.tsx` | `src/pages/DevLogs.tsx` | Timeline + Tag |
| `app/ideas/page.tsx` | `src/pages/Ideas.tsx` | Card + Tag |

### 需要重写的组件（11 个业务组件）

| 现有文件 | 新文件 | Ant Design 替代 |
|---------|--------|----------------|
| `components/layout/sidebar.tsx` | `src/layouts/MainLayout.tsx` (内嵌) | Layout.Sider + Menu |
| `components/layout/page-header.tsx` | 删除 | Ant Design 的 Flex + Typography |
| `components/dashboard/stats-card.tsx` | `src/components/StatsCard.tsx` | Card + Statistic |
| `components/goals/goal-card.tsx` | `src/components/goals/GoalCard.tsx` | Card + Progress + Tag |
| `components/goals/goal-dag.tsx` | `src/components/goals/GoalDAG.tsx` | 保留 ReactFlow，去掉 Tailwind 类名 |
| `components/goals/task-node.tsx` | `src/components/goals/TaskNode.tsx` | 保留 ReactFlow 节点，CSS Modules 替代 |
| `components/goals/task-panel.tsx` | `src/components/goals/TaskPanel.tsx` | Card + List + Button + Space |
| `components/goals/drive-controls.tsx` | `src/components/goals/DriveControls.tsx` | Button + Tag + Space |
| `components/goals/status-badge.tsx` | `src/components/goals/StatusBadge.tsx` | Tag (color prop) |
| `components/tasks/task-tree.tsx` | `src/components/tasks/TaskTree.tsx` | Tree 或自定义列表 |
| `components/tasks/message-history.tsx` | `src/components/tasks/MessageHistory.tsx` | List + 自定义气泡 CSS |

### 完全删除（shadcn/ui 基础组件）
- `components/ui/badge.tsx`
- `components/ui/button.tsx`
- `components/ui/card.tsx`
- `components/ui/dialog.tsx`
- `components/ui/progress.tsx`
- `components/ui/select.tsx`
- `components/ui/separator.tsx`
- `components/ui/tabs.tsx`
- `lib/utils.ts` (cn 函数不再需要)

### 删除的配置文件
- `components.json` (shadcn/ui)
- `postcss.config.mjs` (Tailwind)
- `next.config.ts` (Next.js)
- `app/globals.css` (Tailwind + shadcn 主题)

## 新增的目录结构

```
web/
├── index.html                # Vite 入口
├── vite.config.ts            # Vite 配置
├── tsconfig.json             # 更新 paths
├── package.json              # 更新依赖
├── src/
│   ├── main.tsx              # React 挂载 + Router
│   ├── App.tsx               # 路由定义
│   ├── theme.ts              # Ant Design 主题 token
│   ├── layouts/
│   │   └── MainLayout.tsx    # Sider + Content 布局
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── Goals.tsx
│   │   ├── GoalDetail.tsx
│   │   ├── Tasks.tsx
│   │   ├── TaskDetail.tsx
│   │   ├── DevLogs.tsx
│   │   └── Ideas.tsx
│   ├── components/
│   │   ├── StatsCard.tsx
│   │   ├── goals/
│   │   │   ├── GoalCard.tsx
│   │   │   ├── GoalDAG.tsx
│   │   │   ├── TaskNode.tsx
│   │   │   ├── TaskNode.module.css
│   │   │   ├── TaskPanel.tsx
│   │   │   ├── DriveControls.tsx
│   │   │   └── StatusBadge.tsx
│   │   └── tasks/
│   │       ├── TaskTree.tsx
│   │       ├── MessageHistory.tsx
│   │       └── MessageHistory.module.css
│   └── lib/
│       ├── api.ts
│       ├── types.ts
│       ├── format.ts
│       └── hooks/
│           ├── use-goals.ts
│           ├── use-tasks.ts
│           ├── use-devlogs.ts
│           └── use-ideas.ts
```

## 实施步骤

### Step 1: 初始化 Vite 项目 + 安装依赖
- 备份 `web/` 中需要保留的文件（lib/、类型）
- 删除旧文件，创建 Vite 项目骨架
- 安装：`react`, `react-dom`, `react-router`, `antd`, `@ant-design/icons`, `swr`, `@xyflow/react`
- 配置 `vite.config.ts`（alias `@/` → `src/`）
- 配置 `tsconfig.json`

### Step 2: 搭建 Layout + 路由
- 创建 `src/main.tsx`（BrowserRouter）
- 创建 `src/App.tsx`（路由表）
- 创建 `src/theme.ts`（Ant Design 主题配置）
- 创建 `src/layouts/MainLayout.tsx`（Layout.Sider + Menu + Outlet）

### Step 3: 迁移 lib 层
- 复制 `lib/types.ts` `lib/format.ts` `lib/hooks/*`
- 修改 `lib/api.ts`（`NEXT_PUBLIC_API_URL` → `VITE_API_URL`）
- 删除所有 `'use client'` 指令

### Step 4: 迁移 Dashboard 页面
- 用 `Card` + `Statistic` 替代 StatsCard
- 用 `Card` + `List` 替代 Active Goals / DevLogs 列表
- 用 React Router `<Link>` 替代 Next.js `<Link>`

### Step 5: 迁移 Goals 页面
- Goals 列表：`Select` + `Card` 网格 + `Empty`
- GoalCard：`Card` + `Progress` + `Tag`
- StatusBadge：`Tag` (用 color prop)

### Step 6: 迁移 Goal Detail 页面
- `Breadcrumb` + `Tabs` + `Tag`
- GoalDAG：保留 ReactFlow，CSS Modules 替代 Tailwind 类名
- TaskNode：CSS Modules 替代 Tailwind
- TaskPanel：`Card` + `List` + `Button` + `Space`
- DriveControls：`Button` + `Tag` + `Space`

### Step 7: 迁移 Tasks 页面
- Tasks 列表：`Card` 容器
- TaskTree：自定义树形列表（保持当前展开/收起交互）
- React Router `<Link>` 替代 Next.js `<Link>`

### Step 8: 迁移 Task Detail 页面
- `Breadcrumb` + `Descriptions` + `Card`
- MessageHistory：自定义气泡样式 (CSS Modules)

### Step 9: 迁移 DevLogs 页面
- `Timeline` 组件直接替代手动的时间线 div
- `Tag` 替代 Badge

### Step 10: 迁移 Ideas 页面
- 按状态分组：用 `Collapse`/`Divider` 或直接分组标题
- `Card` + `Tag`

### Step 11: 清理 + 验证
- 删除所有旧文件（app/、components/ui/ 等）
- 确保 `npm run dev` 正常
- 确保 `npm run build` 无错误
- 验证所有页面功能正常

## 组件映射速查表

| shadcn/ui | Ant Design |
|-----------|------------|
| `<Card>` | `<Card>` |
| `<Badge>` | `<Tag>` |
| `<Button>` | `<Button>` |
| `<Select>` | `<Select>` |
| `<Tabs>` | `<Tabs>` |
| `<Progress>` | `<Progress>` |
| `<Dialog>` | `<Modal>` |
| `<Separator>` | `<Divider>` |
| `cn()` 类名合并 | 不再需要 |
| Lucide icons | @ant-design/icons |
| Next.js `<Link>` | React Router `<Link>` |
| `usePathname()` | `useLocation()` |
| `use(params)` | `useParams()` |
