import { Card, Statistic } from 'antd';
import type { ReactNode } from 'react';

interface StatsCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon?: ReactNode;
}

export function StatsCard({ title, value, description, icon }: StatsCardProps) {
  return (
    <Card size="small">
      <Statistic
        title={title}
        value={value}
        prefix={icon}
        suffix={description ? <span style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>{description}</span> : undefined}
      />
    </Card>
  );
}
