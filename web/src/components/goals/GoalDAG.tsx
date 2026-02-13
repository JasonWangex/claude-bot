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
import type { GoalTask } from '@/lib/types';

const nodeTypes = { task: TaskNode };

const NODE_WIDTH = 240;
const NODE_HEIGHT = 100;
const HORIZONTAL_GAP = 60;
const VERTICAL_GAP = 80;

function buildLayout(tasks: GoalTask[]): { nodes: Node[]; edges: Edge[] } {
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  const depthCache = new Map<string, number>();
  function getDepth(taskId: string, visiting = new Set<string>()): number {
    if (depthCache.has(taskId)) return depthCache.get(taskId)!;
    if (visiting.has(taskId)) return 0;
    visiting.add(taskId);
    const task = taskMap.get(taskId);
    if (!task || task.depends.length === 0) {
      depthCache.set(taskId, 0);
      return 0;
    }
    const depth = Math.max(...task.depends.map(d => getDepth(d, visiting) + 1));
    depthCache.set(taskId, depth);
    return depth;
  }

  tasks.forEach(t => getDepth(t.id));

  const layers = new Map<number, GoalTask[]>();
  tasks.forEach(task => {
    const depth = depthCache.get(task.id) ?? 0;
    if (!layers.has(depth)) layers.set(depth, []);
    layers.get(depth)!.push(task);
  });

  const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);
  const maxLayerSize = sortedLayers.length > 0
    ? Math.max(...sortedLayers.map(([, tasks]) => tasks.length))
    : 1;
  const totalWidth = maxLayerSize * (NODE_WIDTH + HORIZONTAL_GAP);

  const nodes: Node[] = [];
  sortedLayers.forEach(([layerIndex, layerTasks]) => {
    const layerWidth = layerTasks.length * (NODE_WIDTH + HORIZONTAL_GAP) - HORIZONTAL_GAP;
    const startX = (totalWidth - layerWidth) / 2;

    layerTasks.forEach((task, indexInLayer) => {
      nodes.push({
        id: task.id,
        type: 'task',
        position: {
          x: startX + indexInLayer * (NODE_WIDTH + HORIZONTAL_GAP),
          y: layerIndex * (NODE_HEIGHT + VERTICAL_GAP),
        },
        data: { task },
      });
    });
  });

  const edges: Edge[] = [];
  tasks.forEach(task => {
    task.depends.forEach(depId => {
      edges.push({
        id: `${depId}->${task.id}`,
        source: depId,
        target: task.id,
        animated: task.status === 'running' || task.status === 'dispatched',
        style: {
          stroke: task.status === 'completed' ? '#52c41a' :
                  task.status === 'failed' ? '#ff4d4f' :
                  '#d9d9d9',
          strokeWidth: 2,
        },
      });
    });
  });

  return { nodes, edges };
}

export function GoalDAG({ tasks }: { tasks: GoalTask[] }) {
  const { nodes, edges } = useMemo(() => buildLayout(tasks), [tasks]);

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

  return (
    <div style={{ height: 500, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fff' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        nodesDraggable={false}
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
