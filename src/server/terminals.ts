import express from 'express';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import type { Duplex } from 'node:stream';
import type { IDisposable, IPtyForkOptions } from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

export const MAX_TERMINALS = 4;
export const TERMINAL_SCROLLBACK_LIMIT = 200_000;
export const TERMINAL_INPUT_LIMIT = 16_384;
const MAX_SOCKET_BUFFER = 1_000_000;
const dimensions = {
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
};
const createSchema = z.object({ cols: dimensions.cols.default(80), rows: dimensions.rows.default(24) }).strict();
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(TERMINAL_INPUT_LIMIT) }).strict(),
  z.object({ type: z.literal('resize'), ...dimensions }).strict(),
]);

export type TerminalSummary = {
  id: string;
  title: string;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode?: number;
};

export interface TerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable;
}

export interface TerminalServiceOptions {
  /** Test hooks also allow hosts to choose a specific login shell. */
  spawn?: (shell: string, args: string[], options: IPtyForkOptions) => TerminalProcess;
  shell?: string;
  shellArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

type TerminalSession = {
  summary: TerminalSummary;
  process: TerminalProcess;
  output: string;
  clients: Set<WebSocket>;
  subscriptions: IDisposable[];
  exited: Promise<void>;
  resolveExit: () => void;
  signal?: number;
  stop?: Promise<void>;
};

function failure(status: number, message: string) { return Object.assign(new Error(message), { status }); }

function spawnNativePty(shell: string, args: string[], options: IPtyForkOptions): TerminalProcess {
  // Native helpers can be unavailable in a signed app. Keep the rest of the
  // local service usable until the user actually opens a terminal.
  const { spawn } = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
  return spawn(shell, args, options);
}

function loginShell(environment: NodeJS.ProcessEnv) {
  if (environment.SHELL) return environment.SHELL;
  try { const shell = userInfo().shell; if (shell) return shell; } catch { /* Use a platform fallback. */ }
  return process.platform === 'win32' ? environment.COMSPEC || 'powershell.exe' : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

function appendOutput(previous: string, incoming: string) {
  const combined = previous + incoming;
  if (combined.length <= TERMINAL_SCROLLBACK_LIMIT) return combined;
  const tail = combined.slice(-TERMINAL_SCROLLBACK_LIMIT);
  // A bounded replay must not begin halfway through a UTF-16 surrogate pair.
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
}

/** All routes/upgrades must run behind the host's project authentication checks. */
export function createTerminalService(workspace: string, options: TerminalServiceOptions = {}) {
  const cwd = realpathSync(workspace);
  if (!statSync(cwd).isDirectory()) throw new Error('A terminal workspace must be a directory.');
  const environment = options.env ?? process.env;
  const shell = options.shell ?? loginShell(environment);
  const shellArgs = options.shellArgs ?? (process.platform === 'win32' ? [] : ['-l']);
  const spawn = options.spawn ?? spawnNativePty;
  const sessions = new Map<string, TerminalSession>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const router = express.Router();
  let sequence = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  const summary = (session: TerminalSession): TerminalSummary => ({ ...session.summary });
  function send(socket: WebSocket, event: object) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER) { socket.close(1013, 'Reconnect to catch up with terminal output.'); return; }
    socket.send(JSON.stringify(event));
  }
  function broadcast(session: TerminalSession, event: object) { for (const socket of session.clients) send(socket, event); }
  function dispose(session: TerminalSession) { for (const subscription of session.subscriptions.splice(0)) subscription.dispose(); }
  function create(cols: number, rows: number) {
    if (closed) throw failure(503, 'The terminal service is closed.');
    if (sessions.size >= MAX_TERMINALS) throw failure(409, 'Close a terminal before opening another. Each project supports four terminals.');
    let terminal: TerminalProcess;
    try {
      terminal = spawn(shell, shellArgs, {
        name: 'xterm-256color', cols, rows, cwd, encoding: 'utf8',
        env: { ...environment, PWD: cwd, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Canvagent' },
      });
    } catch {
      throw failure(503, 'Unable to start a terminal. The native terminal helper or login shell is unavailable. Reinstall Canvagent or check your login shell, then try again.');
    }
    let resolveExit!: () => void;
    const session: TerminalSession = {
      summary: { id: randomUUID(), title: `${basename(shell)} ${++sequence}`, cols, rows, exited: false },
      process: terminal, output: '', clients: new Set(), subscriptions: [],
      exited: new Promise<void>(resolve => { resolveExit = resolve; }), resolveExit: () => resolveExit(),
    };
    sessions.set(session.summary.id, session);
    session.subscriptions.push(terminal.onData(data => {
      session.output = appendOutput(session.output, data);
      broadcast(session, { type: 'data', data });
    }));
    session.subscriptions.push(terminal.onExit(event => {
      session.summary.exited = true;
      session.summary.exitCode = event.exitCode;
      session.signal = event.signal;
      broadcast(session, { type: 'exit', exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) });
      session.resolveExit();
      dispose(session);
    }));
    return session;
  }
  function find(id: string) {
    const session = sessions.get(id);
    if (!session) throw failure(404, 'Terminal not found.');
    return session;
  }
  function stop(session: TerminalSession): Promise<void> {
    if (session.stop) return session.stop;
    session.stop = (async () => {
      for (const socket of session.clients) socket.terminate();
      session.clients.clear();
      if (!session.summary.exited) {
        try { session.process.kill(); } catch { /* The process may already have exited. */ }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([session.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
        clearTimeout(timer);
        if (!session.summary.exited) {
          try { session.process.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch { /* Already gone. */ }
        }
      }
      dispose(session);
    })();
    return session.stop;
  }

  router.use(express.json({ limit: '32kb' }));
  router.use((_req, _res, next) => closed ? next(failure(503, 'The terminal service is closed.')) : next());
  router.get('/', (_req, res) => res.json({ terminals: [...sessions.values()].map(summary) }));
  router.post('/', (req, res) => {
    const input = createSchema.parse(req.body ?? {});
    res.status(201).json({ terminal: summary(create(input.cols, input.rows)) });
  });
  router.post('/:id/close', async (req, res) => {
    const session = find(req.params.id);
    sessions.delete(session.summary.id);
    await stop(session);
    res.json({ ok: true });
  });

  function connect(session: TerminalSession, socket: WebSocket) {
    if (closed || !sessions.has(session.summary.id)) { socket.close(1001, 'Terminal closed.'); return; }
    session.clients.add(socket);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => session.clients.delete(socket));
    send(socket, { type: 'ready', terminal: summary(session), output: session.output });
    if (session.summary.exited) send(socket, { type: 'exit', exitCode: session.summary.exitCode, ...(session.signal === undefined ? {} : { signal: session.signal }) });
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('Terminal messages must be JSON text.');
        const parsed = messageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) throw new Error('Invalid terminal input or dimensions.');
        const message = parsed.data;
        if (message.type === 'input') {
          if (session.summary.exited) throw new Error('This terminal has exited. Open a new terminal to continue.');
          if (message.data) session.process.write(message.data);
        } else {
          if (!session.summary.exited) session.process.resize(message.cols, message.rows);
          session.summary.cols = message.cols; session.summary.rows = message.rows;
        }
      } catch (error) {
        send(socket, { type: 'error', message: error instanceof SyntaxError ? 'Terminal messages must be valid JSON.' : error instanceof Error ? error.message : 'Terminal request failed.' });
      }
    });
  }

  return {
    router,
    // The application checks cookie, host, and origin before calling this.
    // Only the exact project-stripped terminal event route is accepted here.
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      let pathname: string;
      try { pathname = new URL(req.url ?? '', 'http://localhost').pathname; } catch { return false; }
      const match = /^\/api\/terminals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/events$/.exec(pathname);
      if (!match) return false;
      const session = sessions.get(match[1]);
      if (closed || !session) {
        socket.write(`HTTP/1.1 ${closed ? '503 Service Unavailable' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return true;
      }
      wss.handleUpgrade(req, socket, head, client => connect(session, client));
      return true;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      const pending = [...sessions.values()].map(stop);
      sessions.clear();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      closing = Promise.all(pending).then(() => undefined);
      return closing;
    },
  };
}
