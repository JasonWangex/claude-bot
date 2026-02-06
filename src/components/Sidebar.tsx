import type { SessionInfo } from '../lib/api';

interface SidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onLogout: () => void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onLogout,
}: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>Sessions</h2>
        <button className="logout-btn" onClick={onLogout}>
          Logout
        </button>
      </div>
      <button className="new-session-btn" onClick={onNewSession}>
        + New Session
      </button>
      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="session-empty">No active sessions. Create one to get started.</div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === activeSessionId ? 'active' : ''}`}
              onClick={() => onSelectSession(session.id)}
            >
              <div className="session-info">
                <div className="session-name">
                  <span className={`status-dot ${session.alive ? 'alive' : 'dead'}`} />
                  {session.name}
                </div>
              </div>
              <button
                className="close-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSession(session.id);
                }}
                title="Close session"
              >
                &times;
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
