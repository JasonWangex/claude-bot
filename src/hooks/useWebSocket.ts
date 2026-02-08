import { useRef, useCallback, useEffect } from 'react';
import { getWsUrl, getAuthToken } from '../lib/api';

interface UseWebSocketOptions {
  sessionId: string;
  onData: (data: string) => void;
  onClose?: (code: number, reason: string) => void;
  onOpen?: () => void;
  getSize?: () => { cols: number; rows: number } | null;
}

export function useWebSocket({ sessionId, onData, onClose, onOpen, getSize }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const maxReconnect = 5;

  // Store callbacks in refs to avoid triggering reconnection on callback identity change
  const onDataRef = useRef(onData);
  const onCloseRef = useRef(onClose);
  const onOpenRef = useRef(onOpen);
  const getSizeRef = useRef(getSize);
  onDataRef.current = onData;
  onCloseRef.current = onClose;
  onOpenRef.current = onOpen;
  getSizeRef.current = getSize;

  const connect = useCallback(() => {
    if (!sessionId) return;

    const url = getWsUrl(sessionId);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttempts.current = 0;
      const token = getAuthToken();
      if (!token) {
        ws.close(4001, 'No token');
        return;
      }
      const size = getSizeRef.current?.();
      const authMsg: Record<string, unknown> = { type: 'auth', token };
      if (size) {
        authMsg.cols = size.cols;
        authMsg.rows = size.rows;
      }
      ws.send(JSON.stringify(authMsg));
      onOpenRef.current?.();
    };

    ws.onmessage = (event) => {
      onDataRef.current(event.data);
    };

    ws.onclose = (event) => {
      onCloseRef.current?.(event.code, event.reason);

      // Auto-reconnect with exponential backoff
      if (event.code !== 4001 && event.code !== 4004 && event.code !== 4005 && reconnectAttempts.current < maxReconnect) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 16000);
        reconnectAttempts.current++;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      // Will trigger onclose
    };
  }, [sessionId]); // Only reconnect when sessionId changes

  const send = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    send(`\x01resize:${JSON.stringify({ cols, rows })}`);
  }, [send]);

  const disconnect = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    reconnectAttempts.current = maxReconnect; // prevent reconnect
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      reconnectAttempts.current = maxReconnect;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { send, sendResize, disconnect };
}
