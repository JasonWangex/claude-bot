import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useWebSocket } from '../hooks/useWebSocket';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  sessionId: string;
  visible: boolean;
}

export function Terminal({ sessionId, visible }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);

  const onData = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);

  const onClose = useCallback((code: number, _reason: string) => {
    if (code === 4004) {
      termRef.current?.write('\r\n\x1b[33m[Session ended]\x1b[0m\r\n');
    } else if (code === 4005) {
      termRef.current?.write('\r\n\x1b[31m[Session is no longer alive]\x1b[0m\r\n');
    } else if (code === 4006) {
      termRef.current?.write('\r\n\x1b[33m[Disconnected, reconnecting...]\x1b[0m\r\n');
    }
  }, []);

  const getSize = useCallback(() => {
    const term = termRef.current;
    if (term) return { cols: term.cols, rows: term.rows };
    return null;
  }, []);

  // Always keep WS connected regardless of visibility
  const { send, sendResize } = useWebSocket({
    sessionId,
    onData,
    onClose,
    getSize,
  });

  // Store send/sendResize in refs so the xterm setup effect doesn't re-run
  const sendRef = useRef(send);
  const sendResizeRef = useRef(sendResize);
  sendRef.current = send;
  sendResizeRef.current = sendResize;

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // User input → WebSocket (via ref to avoid stale closure)
    term.onData((data) => {
      sendRef.current(data);
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      sendResizeRef.current(term.cols, term.rows);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      initializedRef.current = false;
    };
  }, []); // No dependencies — init once only

  // Refit when visibility changes
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible]);

  return (
    <div
      className="terminal-wrapper"
      style={{ display: visible ? 'block' : 'none' }}
      ref={containerRef}
    />
  );
}
