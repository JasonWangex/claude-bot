'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DriveStatusBadge } from './status-badge';
import { Pause, Play, AlertCircle } from 'lucide-react';
import { pauseDrive, resumeDrive } from '@/lib/hooks/use-goals';
import type { GoalDriveStatus } from '@/lib/types';

interface DriveControlsProps {
  goalId: string;
  status: GoalDriveStatus;
  onAction?: () => void;
}

export function DriveControls({ goalId, status, onAction }: DriveControlsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePause = async () => {
    setLoading(true);
    setError(null);
    try {
      await pauseDrive(goalId);
      onAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '暂停失败');
    } finally {
      setLoading(false);
    }
  };

  const handleResume = async () => {
    setLoading(true);
    setError(null);
    try {
      await resumeDrive(goalId);
      onAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <DriveStatusBadge status={status} />
      {error && (
        <span className="text-xs text-destructive">{error}</span>
      )}
      {status === 'running' && (
        <Button
          variant="outline"
          size="sm"
          onClick={handlePause}
          disabled={loading}
        >
          <Pause className="mr-1.5 h-3.5 w-3.5" />
          暂停
        </Button>
      )}
      {status === 'paused' && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleResume}
          disabled={loading}
        >
          <Play className="mr-1.5 h-3.5 w-3.5" />
          恢复
        </Button>
      )}
      {status === 'failed' && (
        <span className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          Drive 失败
        </span>
      )}
    </div>
  );
}
