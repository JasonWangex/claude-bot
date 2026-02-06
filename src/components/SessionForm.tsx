import { useState, type FormEvent } from 'react';

interface SessionFormProps {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function SessionForm({ onSubmit, onCancel }: SessionFormProps) {
  const [name, setName] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onSubmit(name.trim());
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>New Session</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Session Name</label>
            <input
              type="text"
              placeholder="e.g. my-project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!name.trim()}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
