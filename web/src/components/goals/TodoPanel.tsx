import { useState } from 'react';
import { Checkbox, Input, Button, List, Space, Tag, Popconfirm, Empty, message } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useGoalTodos, addGoalTodo, toggleGoalTodo, deleteGoalTodo } from '@/lib/hooks/use-goal-todos';
import type { GoalTodo } from '@/lib/types';

interface TodoPanelProps {
  goalId: string;
}

export function TodoPanel({ goalId }: TodoPanelProps) {
  const { data: todos, mutate } = useGoalTodos(goalId);
  const [newContent, setNewContent] = useState('');
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    setAdding(true);
    try {
      await addGoalTodo(goalId, newContent.trim(), 'user');
      setNewContent('');
      mutate();
    } catch (err: any) {
      message.error(err?.message || '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (todo: GoalTodo) => {
    try {
      await toggleGoalTodo(goalId, todo.id, !todo.done);
      mutate();
    } catch (err: any) {
      message.error(err?.message || '更新失败');
    }
  };

  const handleDelete = async (todoId: string) => {
    try {
      await deleteGoalTodo(goalId, todoId);
      mutate();
    } catch (err: any) {
      message.error(err?.message || '删除失败');
    }
  };

  const doneCount = todos?.filter(t => t.done).length ?? 0;
  const totalCount = todos?.length ?? 0;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {totalCount > 0 && (
        <span style={{ color: '#888', fontSize: 13 }}>{doneCount}/{totalCount} 完成</span>
      )}

      <Space.Compact style={{ width: '100%' }}>
        <Input
          placeholder="添加待办..."
          value={newContent}
          onChange={e => setNewContent(e.target.value)}
          onPressEnter={handleAdd}
        />
        <Button type="primary" icon={<PlusOutlined />} loading={adding} onClick={handleAdd}>
          添加
        </Button>
      </Space.Compact>

      {(!todos || todos.length === 0) ? (
        <Empty description="暂无待办" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <List
          dataSource={todos}
          renderItem={(todo) => (
            <List.Item
              actions={[
                ...(todo.source ? [<Tag key="source">{todo.source}</Tag>] : []),
                <Popconfirm key="delete" title="确认删除?" onConfirm={() => handleDelete(todo.id)}>
                  <Button type="text" danger icon={<DeleteOutlined />} size="small" />
                </Popconfirm>,
              ]}
            >
              <Checkbox
                checked={todo.done}
                onChange={() => handleToggle(todo)}
              >
                <span style={{
                  textDecoration: todo.done ? 'line-through' : 'none',
                  color: todo.done ? '#999' : undefined,
                }}>
                  {todo.content}
                </span>
              </Checkbox>
            </List.Item>
          )}
        />
      )}
    </Space>
  );
}
