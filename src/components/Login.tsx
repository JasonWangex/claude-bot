import { useState, type FormEvent } from 'react';

interface LoginProps {
  onLogin: (password: string) => Promise<void>;
  error: string;
  loading: boolean;
}

export function Login({ onLogin, error, loading }: LoginProps) {
  const [password, setPassword] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (password.trim()) {
      onLogin(password);
    }
  };

  return (
    <div className="login-container">
      <form className="login-box" onSubmit={handleSubmit}>
        <h1>Claude Web Terminal</h1>
        <p>Enter password to access terminal sessions</p>
        {error && <div className="login-error">{error}</div>}
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <button type="submit" disabled={loading || !password.trim()}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
