import { useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TaskNode } from './TaskNode';
import type { GoalTask, GoalTaskStatus } from '@/lib/types';

const nodeTypes = { task: TaskNode };

const NODE_WIDTH = 280;
const NODE_HEIGHT = 110;
const HORIZONTAL_GAP = 40;
const VERTICAL_GAP = 80;
const PHASE_HEADER_HEIGHT = 40;

function getPhaseNumber(task: GoalTask): number {
  return task.phase ?? 1;
}

function buildLayout(tasks: GoalTask[]): { nodes: Node[]; edges: Edge[]; phaseCount: number } {
  if (tasks.length === 0) return { nodes: [], edges: [], phaseCount: 0 };

  // 按 phase 分组
  const phaseMap = new Map<number, GoalTask[]>();
  for (const task of tasks) {
    const phase = getPhaseNumber(task);
    if (!phaseMap.has(phase)) phaseMap.set(phase, []);
    phaseMap.get(phase)!.push(task);
  }

  const sortedPhases = [...phaseMap.keys()].sort((a, b) => a - b);
  const maxTasksInPhase = Math.max(...sortedPhases.map(p => phaseMap.get(p)!.length));
  const columnWidth = NODE_WIDTH + HORIZONTAL_GAP;
  const totalWidth = maxTasksInPhase * columnWidth;

  const nodes: Node[] = [];

  sortedPhases.forEach((phase, phaseIndex) => {
    const phaseTasks = phaseMap.get(phase)!;
    const phaseWidth = phaseTasks.length * columnWidth - HORIZONTAL_GAP;
    const startX = (totalWidth - phaseWidth) / 2;
    const y = phaseIndex * (NODE_HEIGHT + VERTICAL_GAP + PHASE_HEADER_HEIGHT);

    // Phase 标题节点
    nodes.push({
      id: `phase-${phase}`,
      type: 'default',
      position: { x: startX, y },
      data: { label: `Phase ${phase}` },
      draggable: false,
      selectable: false,
      style: {
        width: phaseWidth,
        height: PHASE_HEADER_HEIGHT - 10,
        background: '#f0f5ff',
        border: '1px solid #adc6ff',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 600,
        color: '#2f54eb',
        pointerEvents: 'none' as const,
      },
    });

    // 任务节点
    phaseTasks.forEach((task, indexInPhase) => {
      nodes.push({
        id: task.id,
        type: 'task',
        position: {
          x: startX + indexInPhase * columnWidth,
          y: y + PHASE_HEADER_HEIGHT,
        },
        data: { task },
      });
    });
  });

  // Phase 间的连接线（phase N → phase N+1 的代表性连线）
  const edges: Edge[] = [];
  for (let i = 0; i < sortedPhases.length - 1; i++) {
    const currentPhase = sortedPhases[i];
    const nextPhase = sortedPhases[i + 1];
    const currentTasks = phaseMap.get(currentPhase)!;
    const nextTasks = phaseMap.get(nextPhase)!;

    // 用第一个任务对建立连线，表示 phase 顺序依赖
    if (currentTasks.length > 0 && nextTasks.length > 0) {
      const sourceTask = currentTasks[Math.floor(currentTasks.length / 2)];
      const targetTask = nextTasks[Math.floor(nextTasks.length / 2)];
      edges.push({
        id: `phase-${currentPhase}->${nextPhase}`,
        source: sourceTask.id,
        target: targetTask.id,
        animated: nextTasks.some(t => t.status === 'running' || t.status === 'dispatched'),
        style: {
          stroke: '#adc6ff',
          strokeWidth: 2,
          strokeDasharray: '6 3',
        },
        label: `→ Phase ${nextPhase}`,
        labelStyle: { fontSize: 10, fill: '#8c8c8c' },
        labelBgStyle: { fill: 'transparent' },
      });
    }
  }

  return { nodes, edges, phaseCount: sortedPhases.length };
}

interface GoalDAGProps {
  tasks: GoalTask[];
  highlightStatuses?: GoalTaskStatus[];
}

export function GoalDAG({ tasks, highlightStatuses }: GoalDAGProps) {
  const { nodes, edges, phaseCount } = useMemo(() => buildLayout(tasks), [tasks]);

  const displayNodes = useMemo(() => {
    if (!highlightStatuses || highlightStatuses.length === 0) return nodes;
    return nodes.map(n => {
      if (!n.data.task) return n; // phase header node
      const task = (n.data as { task: GoalTask }).task;
      return { ...n, data: { ...n.data, dimmed: !highlightStatuses.includes(task.status) } };
    });
  }, [nodes, highlightStatuses]);

  const displayEdges = useMemo(() => {
    if (!highlightStatuses || highlightStatuses.length === 0) return edges;
    return edges.map(e => ({ ...e, style: { ...e.style, opacity: 0.15 }, animated: false }));
  }, [edges, highlightStatuses]);

  if (tasks.length === 0) {
    return (
      <div style={{
        height: 400,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px dashed #d9d9d9',
        borderRadius: 8,
        color: '#999',
      }}>
        暂无任务数据
      </div>
    );
  }

  const containerHeight = Math.min(700, Math.max(400, phaseCount * (NODE_HEIGHT + VERTICAL_GAP + PHASE_HEADER_HEIGHT) + 100));

  return (
    <div style={{ height: containerHeight, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fff' }}>
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.5}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      </ReactFlow>
    </div>
  );
}
