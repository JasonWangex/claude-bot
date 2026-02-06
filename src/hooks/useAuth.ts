import { useState, useCallback } from 'react';
import { login as apiLogin, logout as apiLogout, isLoggedIn } from '../lib/api';

export function useAuth() {
  const [authenticated, setAuthenticated] = useState(isLoggedIn());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const login = useCallback(async (password: string) => {
    setLoading(true);
    setError('');
    try {
      await apiLogin(password);
      setAuthenticated(true);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    apiLogout();
    setAuthenticated(false);
  }, []);

  return { authenticated, login, logout, error, loading };
}
