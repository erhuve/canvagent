import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, apiPath, errorMessage } from './api';
import { Icon } from './icons';

type TerminalSession = { id: string; title: string; cols: number; rows: number; exited: boolean; exitCode?: number };
type TerminalPanelProps = { active: boolean; projectKey: string; height: number; onHeightChange(height: number): void; onHide(): void };

function TerminalView({ session, active, focusRequest, onUpdate }: { session: TerminalSession; active: boolean; focusRequest: number; onUpdate(session: TerminalSession): void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const fit = useRef<() => void>();
  const latest = useRef({ session, active, onUpdate });
  latest.current = { session, active, onUpdate };
  const [connection, setConnection] = useState('Connecting…');
  const [failure, setFailure] = useState('');

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let ready = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let frame = 0;
    const term = new Terminal({
      cols: session.cols || 80, rows: session.rows || 24, cursorBlink: true, cursorStyle: 'bar',
      fontSize: 12, fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      lineHeight: 1.25, scrollback: 5000, screenReaderMode: true, disableStdin: true,
      theme: {
        background: '#ffffff', foreground: '#3f3f4b', cursor: '#68627d', cursorAccent: '#ffffff',
        selectionBackground: '#e5e3fa', black: '#3c3c46', red: '#b84343', green: '#3d7c59',
        yellow: '#9b762e', blue: '#456ab5', magenta: '#8b5ca3', cyan: '#347e86', white: '#ddddE4',
        brightBlack: '#888894', brightRed: '#ce5b5b', brightGreen: '#4e976b', brightYellow: '#b58c3e',
        brightBlue: '#6389d4', brightMagenta: '#a879bf', brightCyan: '#4c9ca4', brightWhite: '#ffffff',
      },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(host.current);
    term.textarea?.setAttribute('aria-label', 'Terminal input');
    terminal.current = term;
    const send = (message: object) => {
      if (ready && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const size = term.onResize(({ cols, rows }) => send({ type: 'resize', cols: Math.min(500, Math.max(2, cols)), rows: Math.min(200, Math.max(1, rows)) }));
    const input = term.onData(data => {
      if (latest.current.session.exited) return;
      for (let start = 0; start < data.length;) {
        let end = Math.min(start + 8192, data.length);
        if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end -= 1;
        send({ type: 'input', data: data.slice(start, end) });
        start = end;
      }
    });
    const fitNow = () => {
      if (disposed || !latest.current.active || !host.current?.clientWidth || !host.current.clientHeight) return;
      try {
        addon.fit();
        if (term.cols > 500 || term.rows > 200) term.resize(Math.min(500, term.cols), Math.min(200, term.rows));
      } catch { /* Font metrics can be unavailable during the first layout. */ }
    };
    const scheduleFit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fitNow); };
    fit.current = scheduleFit;
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host.current);
    void document.fonts.ready.then(() => { if (!disposed) scheduleFit(); });
    const connect = () => {
      if (disposed) return;
      ready = false;
      term.options.disableStdin = true;
      setConnection(attempts ? 'Reconnecting…' : 'Connecting…');
      const url = new URL(apiPath(`/api/terminals/${encodeURIComponent(session.id)}/events`), location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onmessage = event => {
        if (disposed) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'ready') {
            ready = true;
            attempts = 0;
            setFailure('');
            latest.current.onUpdate(message.terminal);
            term.reset();
            if (message.output) term.write(message.output);
            term.options.disableStdin = !!message.terminal.exited;
            setConnection(message.terminal.exited ? `Exited${message.terminal.exitCode === undefined ? '' : ` (${message.terminal.exitCode})`}` : 'Connected');
            fitNow();
            send({ type: 'resize', cols: term.cols, rows: term.rows });
            if (latest.current.active && host.current?.clientWidth) term.focus();
          } else if (message.type === 'data') term.write(message.data);
          else if (message.type === 'exit') {
            term.options.disableStdin = true;
            latest.current.onUpdate({ ...latest.current.session, exited: true, exitCode: message.exitCode });
            setConnection(`Exited${message.exitCode === undefined ? '' : ` (${message.exitCode})`}`);
          } else if (message.type === 'error') setFailure(message.message || 'Terminal connection failed.');
        } catch { setFailure('The terminal sent an invalid response.'); }
      };
      socket.onerror = () => { if (!disposed) setFailure('Terminal connection unavailable. Reconnecting…'); };
      socket.onclose = () => {
        if (disposed || latest.current.session.exited) return;
        ready = false;
        term.options.disableStdin = true;
        setConnection('Reconnecting…');
        reconnect = setTimeout(connect, Math.min(5000, 400 * 2 ** attempts++));
      };
    };
    connect();
    scheduleFit();
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      cancelAnimationFrame(frame);
      observer.disconnect();
      socket?.close();
      input.dispose();
      size.dispose();
      term.dispose();
      terminal.current = undefined;
      fit.current = undefined;
    };
  }, [session.id]);

  useEffect(() => {
    if (!active) { terminal.current?.blur(); return; }
    fit.current?.();
    const frame = requestAnimationFrame(() => {
      if (host.current?.clientWidth && host.current.clientHeight) terminal.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focusRequest]);

  return <div className="terminal-session" hidden={!active} role="tabpanel" aria-label={session.title}>
    <div ref={host} className="terminal-output" />
    <div className={`terminal-session-footer ${failure ? 'has-error' : ''}`}><span role={failure ? 'alert' : 'status'}>{failure || connection}</span><span>{session.exited ? 'Session ended' : 'Shell runs in this project'}</span></div>
  </div>;
}

export function TerminalPanel({ active, projectKey, height, onHeightChange, onHide }: TerminalPanelProps) {
  const panel = useRef<HTMLElement>(null);
  const boot = useRef<Promise<TerminalSession[]>>();
  const drag = useRef<{ y: number; height: number }>();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState('');
  const [focusRequest, setFocusRequest] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);
  const storageKey = `canvagent:terminal:${projectKey}`;
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setFailure('');
    boot.current ??= (async () => {
      const incoming = await api<{ terminals: TerminalSession[] }>('/api/terminals');
      if (incoming.terminals.length) return incoming.terminals;
      const created = await api<{ terminal: TerminalSession }>('/api/terminals', { cols: 80, rows: 24 });
      return [created.terminal];
    })();
    void boot.current.then(incoming => {
      if (disposed) return;
      setSessions(incoming);
      let saved = '';
      try { saved = sessionStorage.getItem(storageKey) || ''; } catch { /* Session selection is optional. */ }
      setActiveId(incoming.find(session => session.id === saved)?.id ?? incoming.find(session => !session.exited)?.id ?? incoming.at(-1)?.id ?? '');
    }).catch(error => { if (!disposed) setFailure(errorMessage(error)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [retry, storageKey]);
  useEffect(() => { if (activeId) { try { sessionStorage.setItem(storageKey, activeId); } catch { /* Optional preference. */ } } }, [activeId, storageKey]);

  const create = async () => {
    if (busy || loading) return;
    setBusy(true); setFailure('');
    try {
      const incoming = await api<{ terminal: TerminalSession }>('/api/terminals', { cols: 80, rows: 24 });
      setSessions(previous => [...previous, incoming.terminal]);
      setActiveId(incoming.terminal.id);
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const close = async (id: string) => {
    if (busy) return;
    setBusy(true); setFailure('');
    try {
      await api(`/api/terminals/${encodeURIComponent(id)}/close`, {});
      const remaining = sessions.filter(session => session.id !== id);
      setSessions(previous => previous.filter(session => session.id !== id));
      setActiveId(current => current === id ? remaining.at(-1)?.id ?? '' : current);
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const resize = (value: number) => {
    const available = panel.current?.parentElement?.clientHeight ?? 700;
    onHeightChange(Math.min(Math.max(140, value), Math.max(140, available - 150)));
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    drag.current = { y: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return <section ref={panel} className="terminal-panel" aria-label="Project terminal" hidden={!active} style={{ height }}>
    <div className="terminal-resize-handle" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" aria-valuemin={140} aria-valuenow={height} tabIndex={0} onPointerDown={beginResize} onPointerMove={event => { if (drag.current) resize(drag.current.height + drag.current.y - event.clientY); }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resize(height + (event.key === 'ArrowUp' ? 20 : -20)); } }} />
    <header className="terminal-header"><div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">{sessions.map(session => <div className={`terminal-tab ${activeId === session.id ? 'active' : ''}`} key={session.id}><button role="tab" aria-selected={activeId === session.id} aria-label={`Terminal: ${session.title}`} onClick={() => { setActiveId(session.id); setFocusRequest(value => value + 1); }}><Icon name="terminal" size={13} /><span>{session.title}</span>{session.exited && <span className="terminal-exited-dot" title="Session ended" />}</button><button className="terminal-close" aria-label={`Close terminal: ${session.title}`} title="Close terminal" disabled={busy} onClick={() => void close(session.id)}><Icon name="close" size={12} /></button></div>)}</div><div className="terminal-actions"><button className="icon-button" aria-label="New terminal" title="New terminal" disabled={busy || loading} onClick={() => void create()}><Icon name="plus" size={15} /></button><button className="icon-button" aria-label="Hide terminal" title="Hide terminal (Ctrl+`)" onClick={onHide}><Icon name="close" size={15} /></button></div></header>
    {failure && <div className="terminal-error" role="alert"><span>{failure}</span>{!sessions.length && <button disabled={loading} onClick={() => { boot.current = undefined; setRetry(value => value + 1); }}>Retry</button>}</div>}
    <div className="terminal-body">{loading ? <div className="terminal-empty" role="status"><span className="working-spinner" />Starting terminal…</div> : !sessions.length ? <div className="terminal-empty"><span>No open terminals</span><button disabled={busy} onClick={() => void create()}>Start a terminal</button></div> : sessions.map(session => <TerminalView key={session.id} session={session} active={active && activeId === session.id} focusRequest={focusRequest} onUpdate={incoming => setSessions(previous => previous.map(item => item.id === incoming.id ? incoming : item))} />)}</div>
  </section>;
}
