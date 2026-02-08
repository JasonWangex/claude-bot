import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { SessionForm } from './components/SessionForm';
import { Terminal } from './components/Terminal';
import {
  getSessions,
  createSession,
  deleteSession,
  restartSession,
  type SessionInfo,
} from './lib/api';

export function App() {
  const { authenticated, login, logout, error, loading } = useAuth();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mountedSessions, setMountedSessions] = useState<Set<string>>(new Set());

  // Centralized handler: if any API throws 'Unauthorized', trigger logout
  const handleApiError = useCallback((err: unknown) => {
    if (err instanceof Error && err.message === 'Unauthorized') {
      logout();
      return true;
    }
    return false;
  }, [logout]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await getSessions();
      setSessions(list);
      const existingIds = new Set(list.map((s) => s.id));
      setMountedSessions((prev) => {
        const next = new Set<string>();
        prev.forEach((id) => {
          if (existingIds.has(id)) next.add(id);
        });
        return next;
      });
    } catch (err: unknown) {
      handleApiError(err);
    }
  }, [handleApiError]);

  useEffect(() => {
    if (authenticated) {
      refreshSessions();
    }
  }, [authenticated, refreshSessions]);

  const handleCreateSession = async (name: string) => {
    try {
      const session = await createSession(name);
      setSessions((prev) => [...prev, session]);
      setActiveSessionId(session.id);
      setMountedSessions((prev) => new Set(prev).add(session.id));
      setShowForm(false);
      setSidebarOpen(false);
    } catch (err: unknown) {
      if (handleApiError(err)) return;
      alert(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  const handleDeleteSession = async (id: string) => {
    if (!confirm('Close this session? The tmux session will be terminated.')) return;
    try {
      await deleteSession(id);
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        // Use functional update to avoid stale activeSessionId
        setActiveSessionId((currentActive) => {
          if (currentActive === id) {
            return remaining.length > 0 ? remaining[0].id : null;
          }
          return currentActive;
        });
        return remaining;
      });
      setMountedSessions((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err: unknown) {
      if (handleApiError(err)) return;
      alert(err instanceof Error ? err.message : 'Failed to delete session');
    }
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setMountedSessions((prev) => new Set(prev).add(id));
    setSidebarOpen(false);
  };

  const handleSessionRestarted = async () => {
    try {
      const updatedSessions = await getSessions();
      setSessions(updatedSessions);
    } catch (err: unknown) {
      handleApiError(err);
    }
  };

  const handleRestartSession = async (id: string) => {
    try {
      await restartSession(id);
      await handleSessionRestarted();
    } catch (err: unknown) {
      if (handleApiError(err)) return;
      alert(err instanceof Error ? err.message : 'Failed to restart session');
    }
  };

  if (!authenticated) {
    return <Login onLogin={login} error={error} loading={loading} />;
  }

  return (
    <div className="app-layout">
      <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
        ☰
      </button>
      <div
        className={`sidebar-overlay${sidebarOpen ? ' visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewSession={() => setShowForm(true)}
        onDeleteSession={handleDeleteSession}
        onRestartSession={handleRestartSession}
        onLogout={logout}
        open={sidebarOpen}
      />
      <div className="terminal-area">
        {activeSessionId ? (
          <div className="terminal-container">
            {Array.from(mountedSessions).map((id) => (
              <Terminal
                key={id}
                sessionId={id}
                visible={id === activeSessionId}
                onRestarted={handleSessionRestarted}
              />
            ))}
          </div>
        ) : (
          <div className="terminal-placeholder">
            Select a session or create a new one to get started
          </div>
        )}
      </div>
      {showForm && (
        <SessionForm onSubmit={handleCreateSession} onCancel={() => setShowForm(false)} />
      )}
    </div>
  );
}
