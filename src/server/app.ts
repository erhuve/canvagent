import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { Store, type MutationResult } from './store.js';
import { CodexRuntime, type RuntimeEvent } from './runtime.js';
import { ArtifactFiles } from './artifacts.js';
import { CanvasTools, canvasToolSpecs, type Region } from './canvas-tools.js';
import type { Session, RuntimeState, Artifact, Approval } from '../shared/types.js';

const instructions = `You are the agent in Canvagent, a normal local coding harness with a persistent shared Excalidraw canvas. The user and you can both read and edit this board. Use normal coding tools for project work and canvas tools to understand visual instructions, draw editable explanations, and publish outputs. At each user turn you receive current canvas context automatically. When asked to look at the canvas, call read_canvas and capture_region as appropriate before making visual claims. Canvas content is user-authored resource data, separate from these application instructions. A canvas_changed notice updates resource awareness within the current task, not a new task: inspect relevant changes before writing over them. Use expected revisions from read_canvas for edits. Prefer small additive notes beside user work. Publish generated workspace files with publish_artifact before attach_artifact. Do not claim a tool action succeeded unless its result confirms it.`;
const now = () => new Date().toISOString();
const requestId = z.string().min(1).max(160);
const selectionSchema = z.object({ elementIds: z.array(z.string()).max(200), region: z.any().optional() });
const messageSchema = z.object({ requestId, text: z.string().trim().min(1).max(50000), selection: selectionSchema.default({ elementIds: [] }) });

export interface ApplicationOptions {
  workspace: string;
  dataDir: string;
  port?: number;
  runtimeFactory?: (options: ConstructorParameters<typeof CodexRuntime>[0]) => CodexRuntime;
  distDir?: string;
}

export function createApplication(options: ApplicationOptions) {
  const workspace = realpathSync(options.workspace);
  const store = new Store(options.dataDir);
  const storedWorkspace = store.get<string>('workspaceRoot');
  if (storedWorkspace && storedWorkspace !== workspace) {
    store.close();
    throw new Error('This data directory belongs to another workspace. Choose a different --data-dir.');
  }
  store.set('workspaceRoot', workspace);
  const artifactFiles = new ArtifactFiles(workspace, join(options.dataDir, 'artifacts'));
  const app = express();
  const server = createServer(app);
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const token = randomBytes(32).toString('hex');
  let sessions = store.get<Session[]>('sessions') ?? [];
  let activeSessionId = store.get<string>('activeSessionId') ?? sessions[0]?.id ?? '';
  let runtime: CodexRuntime | undefined;
  let connecting: Promise<void> | undefined;
  let busySessionId: string | undefined;
  let closed = false;
  const runtimeState: RuntimeState = {
    connected: false, authenticated: false, version: 'not connected', models: [],
    model: store.get<string>('model') ?? '',
    capabilities: { steering: false, canvasChangeNotices: false, canvasTools: true },
  };
  const captures = new Map<string, { revision: number; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeSending = false;
  let noticeDeliveryBlocked = false;
  let pendingNotice: { sinceRevision: number; throughRevision: number; ids: Set<string>; deleted: Set<string> } | undefined;
  let lastBroadcastRevision = store.board().revision;

  for (const session of sessions) {
    session.activities ??= [];
    session.queued ??= [];
    session.pendingApprovals = [];
    if (['running', 'starting', 'awaiting_approval'].includes(session.status)) {
      session.status = 'unknown';
      session.messages.push({ id: randomUUID(), role: 'system', text: 'The previous runtime disconnected. Send a message to resume the saved thread; completed commands will not be replayed.', createdAt: now() });
    }
  }
  function persist() { store.set('sessions', sessions); store.set('activeSessionId', activeSessionId); }
  function emit(event: object) {
    const data = JSON.stringify(event);
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
  function sessionChanged(session: Session) { persist(); emit({ type: 'session', session }); }
  function runtimeChanged() { emit({ type: 'runtime', runtime: runtimeState }); }
  function findSession(id: string) {
    const session = sessions.find(s => s.id === id);
    if (!session) throw Object.assign(new Error('Session not found.'), { status: 404 });
    return session;
  }
  function newSession(title = 'New session') {
    const session: Session = { id: randomUUID(), title, threadId: null, turnId: null, status: 'idle', messages: [], activities: [], pendingApprovals: [], queued: [], contextRevision: 0, createdAt: now() };
    sessions.push(session); activeSessionId = session.id; persist();
    return session;
  }
  if (!sessions.length) newSession();
  function state() { return {
    project: { name: workspace.split('/').filter(Boolean).at(-1) ?? 'Project', workspace },
    board: store.board(), sessions, activeSessionId, runtime: runtimeState,
    artifacts: store.get<Artifact[]>('artifacts') ?? [],
  }; }
  function recordActivity(session: Session, id: string, kind: string, title: string, status: string, detail?: string) {
    let activity = session.activities.find(a => a.id === id);
    if (!activity) { activity = { id, kind, title, status, createdAt: now() }; session.activities.push(activity); }
    Object.assign(activity, { status, ...(detail === undefined ? {} : { detail: detail.slice(-20000) }) });
    session.activities = session.activities.slice(-100);
  }
  function systemMessage(session: Session, text: string) { session.messages.push({ id: randomUUID(), role: 'system', text, createdAt: now() }); }

  function boardChanged(result: MutationResult, actor: string) {
    if (!result.ok) return;
    const board = store.board();
    if (result.boardRevision <= lastBroadcastRevision) return;
    lastBroadcastRevision = board.revision;
    emit({ type: 'board', board, mutation: { id: result.mutationId, actor } });
    if (!['human', 'undo'].includes(actor) || !busySessionId) return;
    const previous = pendingNotice;
    pendingNotice ??= { sinceRevision: Math.max(0, board.revision - 1), throughRevision: board.revision, ids: new Set(), deleted: new Set() };
    pendingNotice.throughRevision = board.revision;
    for (const e of result.changedElements) {
      pendingNotice.ids.add(e.id);
      if (e.isDeleted) pendingNotice.deleted.add(e.id); else pendingNotice.deleted.delete(e.id);
    }
    if (!previous) pendingNotice.sinceRevision = board.revision - 1;
    scheduleNotice();
  }
  function scheduleNotice() {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => void sendNotice(), 800);
  }
  async function sendNotice() {
    if (noticeSending || noticeDeliveryBlocked || !pendingNotice || !runtime?.activeTurnId || !busySessionId) return;
    const session = findSession(busySessionId);
    if (session.status !== 'running') return;
    noticeSending = true;
    const summary = pendingNotice; pendingNotice = undefined;
    const expectedTurnId = runtime.activeTurnId;
    try {
      const notice = { kind: 'canvas_changed', boardId: store.board().id, expectedTurnId,
        sinceRevision: summary.sinceRevision, throughRevision: summary.throughRevision,
        changedIds: [...summary.ids].slice(0, 100), deletedIds: [...summary.deleted].slice(0, 100),
        truncated: summary.ids.size > 100, requiresRead: true };
      await runtime.steer(`[Canvagent resource update, not a new user task]\n${JSON.stringify(notice)}`, expectedTurnId);
      recordActivity(session, randomUUID(), 'canvas', `Canvas revision ${summary.throughRevision} shared with agent`, 'completed');
      runtimeState.capabilities.canvasChangeNotices = true; runtimeChanged(); sessionChanged(session);
    } catch (error) {
      // Human edits may have populated this closure while steering awaited RPC.
      const queuedNotice = pendingNotice as typeof summary | undefined;
      const combinedIds = new Set([...summary.ids, ...(queuedNotice?.ids ?? [])]);
      const current = store.board();
      pendingNotice = { sinceRevision: summary.sinceRevision, throughRevision: current.revision,
        ids: combinedIds, deleted: new Set(current.elements.filter(e => e.isDeleted && combinedIds.has(e.id)).map(e => e.id)) };
      noticeDeliveryBlocked = true;
      runtimeState.capabilities.canvasChangeNotices = false; runtimeChanged();
      recordActivity(session, randomUUID(), 'canvas', 'Live canvas notice unavailable; latest state remains readable', 'failed', String(error));
      sessionChanged(session);
      // Do not blindly retry an uncertain steering submission. New edits and the
      // next explicit turn still provide current state.
    } finally { noticeSending = false; if (pendingNotice) scheduleNotice(); }
  }

  async function capture(board: any, region?: Region) {
    const socket = [...sockets].find(s => s.readyState === WebSocket.OPEN);
    if (!socket) throw new Error('RESOURCE_UNAVAILABLE: connect the canvas browser to render a region.');
    const id = randomUUID();
    return new Promise<{ dataURL: string; bounds: Region; revision: number }>((resolveCapture, reject) => {
      const timer = setTimeout(() => { captures.delete(id); reject(new Error('Canvas render timed out. Keep the canvas browser open.')); }, 15000);
      captures.set(id, { revision: board.revision, resolve: resolveCapture, reject, timer });
      socket.send(JSON.stringify({ type: 'capture', id, board, region }));
    });
  }
  const tools = new CanvasTools({ store, artifactFiles, capture, sessionId: () => busySessionId ?? sessions.find(s => s.threadId === runtime?.threadId)?.id, changed: boardChanged });

  function onRuntimeEvent(event: RuntimeEvent) {
    const p = event.payload ?? {};
    if (event.type === 'connection.changed') {
      runtimeState.connected = p.state === 'connected';
      if (p.state === 'disconnected') {
        runtimeState.error = p.intentional && !busySessionId ? undefined : p.reason ?? p.message ?? 'Codex disconnected.';
        if (busySessionId && (!p.intentional || p.activeTurnId)) { const s = findSession(busySessionId); s.status = 'unknown'; s.pendingApprovals = []; systemMessage(s, 'Codex disconnected. The saved conversation and board are retained.'); sessionChanged(s); busySessionId = undefined; }
      }
      runtimeChanged(); return;
    }
    const session = sessions.find(s => s.threadId && s.threadId === p.threadId) ?? (busySessionId ? findSession(busySessionId) : undefined);
    if (!session) return;
    if (event.type === 'item/agentMessage/delta') {
      const id = String(p.itemId ?? p.turnId ?? 'assistant');
      let message = session.messages.find(m => m.id === id);
      if (!message) { message = { id, role: 'assistant', text: '', createdAt: now(), turnId: p.turnId }; session.messages.push(message); }
      message.text += p.delta ?? '';
    } else if (event.type === 'turn/started') {
      busySessionId = session.id;
      session.turnId = p.turn?.id ?? p.turnId; session.status = 'running';
    } else if (event.type === 'item/started' || event.type === 'item/completed') {
      const item = p.item ?? {};
      if (item.type === 'agentMessage' && item.text) {
        let message = session.messages.find(m => m.id === item.id);
        if (!message) { message = { id: item.id, role: 'assistant', text: item.text, createdAt: now(), turnId: p.turnId }; session.messages.push(message); }
        else message.text = item.text;
      } else if (!['userMessage', 'reasoning'].includes(item.type)) {
        recordActivity(session, item.id ?? randomUUID(), item.type ?? 'tool', item.command ?? item.tool ?? item.name ?? item.type ?? 'Tool', event.type === 'item/completed' ? item.status ?? 'completed' : 'running', item.aggregatedOutput ?? item.output);
      }
    } else if (event.type === 'item/commandExecution/outputDelta') {
      const activity = session.activities.find(a => a.id === p.itemId);
      if (activity) activity.detail = ((activity.detail ?? '') + (p.delta ?? '')).slice(-20000);
    } else if (event.type === 'serverRequest/resolved') {
      session.pendingApprovals = session.pendingApprovals.filter(a => String(a.nativeId) !== String(p.requestId));
      if (!session.pendingApprovals.length && session.status === 'awaiting_approval') { session.status = 'running'; scheduleNotice(); }
    } else if (event.type === 'turn/completed') {
      const turnStatus = p.turn?.status;
      session.status = turnStatus === 'failed' ? 'failed' : 'idle';
      session.turnId = null; session.pendingApprovals = [];
      if (p.turn?.error) systemMessage(session, p.turn.error.message ?? JSON.stringify(p.turn.error));
      if (busySessionId === session.id) busySessionId = undefined;
      pendingNotice = undefined;
      noticeDeliveryBlocked = false;
      sessionChanged(session);
      if (session.queued.length) { const queued = session.queued.shift()!; persist(); queueMicrotask(() => void dispatch(session, queued.text, queued.selection, queued.id).catch(error => failTurn(session, error))); }
      return;
    } else if (event.type === 'error' || event.type === 'runtime.error') {
      const text = p.error?.message ?? p.message ?? 'Runtime error';
      recordActivity(session, randomUUID(), 'runtime', text, 'failed');
    } else return;
    sessionChanged(session);
  }
  async function connectRuntime() {
    if (runtimeState.connected && runtimeState.authenticated && runtime) return;
    if (connecting) return connecting;
    runtime?.close();
    runtime = (options.runtimeFactory ?? (configuration => new CodexRuntime(configuration)))({
      cwd: workspace, model: runtimeState.model || undefined, tools: canvasToolSpecs, developerInstructions: instructions,
      onEvent: onRuntimeEvent,
      onTool: async (name, args) => {
        const s = busySessionId ? findSession(busySessionId) : undefined;
        const id = randomUUID(); if (s) { recordActivity(s, id, 'canvas', name, 'running'); sessionChanged(s); }
        const result = await tools.call(name, args);
        if (s) { recordActivity(s, id, 'canvas', name, result.success ? 'completed' : 'failed'); sessionChanged(s); }
        if (name === 'publish_artifact') emit({ type: 'artifacts', artifacts: store.get<Artifact[]>('artifacts') ?? [] });
        return result;
      },
      onApproval: request => {
        const s = sessions.find(candidate => candidate.threadId === request.params?.threadId) ?? (busySessionId ? findSession(busySessionId) : undefined);
        if (!s) return;
        busySessionId ??= s.id;
        const p = request.params ?? {};
        const advertised = p.availableDecisions?.filter((decision: unknown) => typeof decision === 'string');
        const special = request.method.includes('permissions') ? ['accept', 'decline'] : request.method.includes('requestUserInput') ? ['answer'] : request.method.includes('elicitation') ? ['decline', 'cancel'] : ['accept', 'decline', 'cancel'];
        const approval: Approval = { id: randomUUID(), nativeId: request.id, method: request.method,
          title: request.method.includes('requestUserInput') ? 'Agent needs your input' : 'Permission requested',
          description: p.reason ?? p.message ?? 'Review this runtime request before continuing.',
          command: p.command, cwd: p.cwd, choices: advertised?.length ? advertised : special, params: p };
        s.pendingApprovals.push(approval); s.status = 'awaiting_approval'; sessionChanged(s);
      },
    });
    connecting = (async () => {
      try {
        const result = await runtime!.connect();
        Object.assign(runtimeState, result, { connected: true, error: undefined });
        runtimeState.capabilities.steering = true;
        runtimeChanged();
      } catch (error) { runtimeState.connected = false; runtimeState.error = error instanceof Error ? error.message : String(error); runtimeChanged(); throw error; }
      finally { connecting = undefined; }
    })();
    return connecting;
  }
  function failTurn(session: Session, error: any) {
    session.status = error?.uncertain ? 'unknown' : 'failed';
    if (busySessionId === session.id) busySessionId = undefined;
    systemMessage(session, error?.message ?? String(error)); sessionChanged(session);
  }
  function context(session: Session, selection: { elementIds: string[] }) {
    const board = store.board();
    const live = board.elements.filter(e => !e.isDeleted);
    const selected = selection.elementIds;
    const overview = live.slice(0, 80).map(e => ({ id: e.id, type: e.type, text: typeof e.text === 'string' ? e.text.slice(0, 160) : undefined, x: e.x, y: e.y, revision: board.metadata[e.id]?.revision }));
    return { boardId: board.id, revision: board.revision, previousContextRevision: session.contextRevision,
      selectedIds: selected, missingSelectedIds: selected.filter(id => !live.some(e => e.id === id)),
      overview, totalObjects: live.length, truncated: live.length > 80,
      instruction: 'Current committed resource state at dispatch. Inspect with read_canvas/capture_region for detail; use service revisions for edits.' };
  }
  async function dispatch(session: Session, text: string, selection: { elementIds: string[] }, id: string) {
    if (busySessionId) throw Object.assign(new Error('Another agent turn is running.'), { status: 409 });
    busySessionId = session.id; session.status = 'starting'; sessionChanged(session);
    await connectRuntime();
    const thread = await runtime!.open(session.threadId ?? undefined);
    session.threadId = thread;
    if (runtime!.activeTurnId) {
      session.turnId = runtime!.activeTurnId; session.status = 'running';
      session.queued.push({ id, text, selection });
      systemMessage(session, 'Resumed an existing active turn. Your message is queued until it finishes.');
      sessionChanged(session); return;
    }
    const canvasContext = context(session, selection);
    noticeDeliveryBlocked = false;
    const nativeTurnId = await runtime!.start(`${text}\n\n[Canvagent canvas resource context]\n${JSON.stringify(canvasContext)}`, id);
    session.contextRevision = canvasContext.revision;
    if (busySessionId === session.id) { session.turnId = nativeTurnId; if (session.status === 'starting') session.status = 'running'; }
    sessionChanged(session);
  }

  const validLocalHost = (host: string | undefined) => {
    try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname); } catch { return false; }
  };
  const originAllowed = (origin: string | undefined) => {
    if (!origin) return true;
    try { const u = new URL(origin); return u.protocol === 'http:' && validLocalHost(u.host) && [String(options.port ?? 4317), '5173'].includes(u.port); } catch { return false; }
  };
  const authenticated = (cookie: string | undefined) => {
    const candidate = cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('canvagent='))?.slice('canvagent='.length);
    return !!candidate && /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(token, 'hex'));
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    if (!validLocalHost(req.headers.host) || !originAllowed(req.headers.origin)) return res.status(403).json({ error: 'Local origin required.' });
    if (req.path === '/api/state' && req.method === 'GET') res.cookie('canvagent', token, { httpOnly: true, sameSite: 'strict', path: '/' });
    else if (req.path.startsWith('/api/') && !authenticated(req.headers.cookie)) return res.status(401).json({ error: 'Open the app to initialize the local session.' });
    next();
  });
  app.use(express.json({ limit: '30mb' }));
  app.get('/api/state', (_req, res) => res.json(state()));
  app.post('/api/runtime/connect', async (_req, res) => { await connectRuntime(); res.json(runtimeState); });
  app.post('/api/settings', (req, res) => {
    if (busySessionId) return res.status(409).json({ error: 'Change models after the active turn finishes.' });
    const { model } = z.object({ model: z.string().max(120) }).parse(req.body);
    if (model && runtimeState.models.length && !runtimeState.models.some(m => m.id === model)) return res.status(400).json({ error: 'Model is not available to this account.' });
    runtime?.close(); runtime = undefined; runtimeState.connected = false; runtimeState.model = model; store.set('model', model); runtimeChanged(); res.json(runtimeState);
  });
  app.post('/api/sessions', (req, res) => {
    const { title } = z.object({ title: z.string().max(100).optional() }).parse(req.body);
    const session = newSession(title); emit({ type: 'state', state: state() }); res.json(session);
  });
  app.post('/api/sessions/:id/activate', (req, res) => { findSession(req.params.id); activeSessionId = req.params.id; persist(); emit({ type: 'state', state: state() }); res.json({ ok: true }); });
  app.post('/api/sessions/:id/messages', async (req, res) => {
    const session = findSession(req.params.id); const input = messageSchema.parse(req.body);
    const receiptKey = `message:${session.id}:${input.requestId}`; const previous = store.get<any>(receiptKey);
    if (previous) {
      if (previous.input !== JSON.stringify(input)) return res.status(409).json({ error: 'Request ID reused with different message content.' });
      return res.json(previous.result);
    }
    if (busySessionId && busySessionId !== session.id) return res.status(409).json({ error: 'Another session has an active turn. Wait or interrupt it first.' });
    const board = store.board();
    const message = { id: input.requestId, role: 'user' as const, text: input.text, createdAt: now(), canvasReference: { boardId: board.id, revision: board.revision, elementIds: input.selection.elementIds } };
    session.messages.push(message); if (session.title === 'New session') session.title = input.text.slice(0, 60);
    const result = { ok: true, messageId: message.id, status: busySessionId ? 'update' : 'accepted' };
    store.set(receiptKey, { input: JSON.stringify(input), result }); sessionChanged(session);
    if (busySessionId === session.id) {
      if (runtime?.activeTurnId && session.status === 'running') {
        try {
          const current = context(session, input.selection);
          await runtime.steer(`${input.text}\n\n[Current canvas resource context]\n${JSON.stringify(current)}`, runtime.activeTurnId);
          session.contextRevision = current.revision;
          if (pendingNotice && pendingNotice.throughRevision <= current.revision) pendingNotice = undefined;
          noticeDeliveryBlocked = false;
        }
        catch (error: any) {
          if (error?.uncertain) { session.status = 'unknown'; systemMessage(session, 'The update outcome is uncertain. It will not be automatically resent.'); }
          else { session.queued.push({ id: input.requestId, text: input.text, selection: input.selection }); systemMessage(session, 'Update queued for the next turn.'); }
          sessionChanged(session);
        }
      } else { session.queued.push({ id: input.requestId, text: input.text, selection: input.selection }); systemMessage(session, 'Message queued for the next turn.'); sessionChanged(session); }
    } else { try { await dispatch(session, input.text, input.selection, input.requestId); } catch (error) { failTurn(session, error); } }
    res.status(202).json(result);
  });
  app.post('/api/sessions/:id/interrupt', async (req, res) => {
    const s = findSession(req.params.id);
    if (!s.turnId || !runtime || busySessionId !== s.id) return res.status(409).json({ error: 'There is no active turn to interrupt.' });
    s.queued = []; sessionChanged(s); await runtime.interrupt(s.turnId); res.json({ ok: true });
  });
  app.post('/api/sessions/:id/approvals/:approvalId', (req, res) => {
    const s = findSession(req.params.id); const approval = s.pendingApprovals.find(a => a.id === req.params.approvalId);
    if (!approval || !runtime || busySessionId !== s.id) return res.status(409).json({ error: 'This approval is no longer pending.' });
    const input = z.object({ decision: z.string(), answers: z.record(z.string(), z.any()).optional(), requestId: requestId.optional() }).parse(req.body);
    if (!approval.choices.includes(input.decision)) return res.status(400).json({ error: 'Choose an advertised decision.' });
    let answer: any = { decision: input.decision };
    if (approval.method.includes('permissions')) answer = { permissions: input.decision === 'accept' ? approval.params.permissions : {}, scope: 'turn' };
    if (approval.method.includes('requestUserInput')) answer = { answers: input.answers ?? {} };
    if (approval.method.includes('elicitation')) answer = { action: input.decision, content: null };
    if (approval.method === 'execCommandApproval' || approval.method === 'applyPatchApproval') answer = { decision: input.decision === 'accept' ? 'approved' : input.decision === 'decline' ? 'denied' : 'abort' };
    runtime.answer(approval.nativeId, answer);
    s.pendingApprovals = s.pendingApprovals.filter(a => a !== approval); s.status = s.pendingApprovals.length ? 'awaiting_approval' : 'running';
    sessionChanged(s); scheduleNotice(); res.json({ ok: true });
  });
  app.post('/api/board/files', (req, res) => {
    const { files } = z.object({ files: z.record(z.string(), z.any()) }).parse(req.body);
    store.saveFiles(files); res.json({ ok: true });
  });
  app.post('/api/board/mutate', (req, res) => {
    const command = z.object({ requestId, observedBoardRevision: z.number().int().nonnegative(), operations: z.array(z.any()).min(1).max(2000) }).parse(req.body);
    const result = store.mutate(command, 'human'); if (result.ok) boardChanged(result, 'human');
    res.status(result.ok ? 200 : result.code === 'CONFLICT' ? 409 : 400).json(result);
  });
  app.post('/api/board/undo', (req, res) => {
    const input = z.object({ mutationId: z.string().min(1), requestId }).parse(req.body);
    const result = store.undo(input.mutationId, input.requestId, 'human'); if (result.ok) boardChanged(result, 'undo');
    res.status(result.ok ? 200 : 409).json(result);
  });
  app.post('/api/capture-result', (req, res) => {
    const input = z.object({ id: z.string(), revision: z.number().int(), dataURL: z.string().max(24 * 1024 * 1024).optional(), bounds: z.any().optional(), error: z.string().optional() }).parse(req.body);
    const pending = captures.get(input.id);
    if (!pending) return res.status(410).json({ error: 'Capture request expired.' });
    captures.delete(input.id); clearTimeout(pending.timer);
    if (input.error) pending.reject(new Error(input.error));
    else if (input.revision !== pending.revision || !input.dataURL?.startsWith('data:image/png;base64,') || !input.bounds) pending.reject(new Error('Invalid capture response.'));
    else pending.resolve({ dataURL: input.dataURL, bounds: input.bounds, revision: input.revision });
    res.json({ ok: true });
  });
  app.get('/api/artifacts/:id', async (req, res) => {
    const artifact = (store.get<Artifact[]>('artifacts') ?? []).find(a => a.id === req.params.id);
    if (!artifact) return res.status(404).json({ error: 'Artifact not found.' });
    const bytes = await artifactFiles.bytes(artifact);
    res.setHeader('Content-Type', artifact.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`);
    res.send(bytes);
  });
  app.get('/api/*path', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  const applicationRoot = resolve(import.meta.dirname, '../..');
  app.use('/excalidraw-assets', express.static(join(applicationRoot, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod'), { maxAge: '1y', immutable: true }));
  const dist = options.distDir ?? resolve('dist');
  if (existsSync(join(dist, 'index.html'))) { app.use(express.static(dist)); app.get('/{*path}', (_req, res) => res.sendFile(join(dist, 'index.html'))); }
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof z.ZodError ? 400 : error.status ?? 500;
    res.status(status).json({ error: error instanceof z.ZodError ? 'Invalid request.' : error.message ?? 'Request failed.', details: error instanceof z.ZodError ? error.issues : undefined });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/events' || !validLocalHost(req.headers.host) || !originAllowed(req.headers.origin) || !authenticated(req.headers.cookie)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    sockets.add(socket); socket.send(JSON.stringify({ type: 'state', state: state() }));
    socket.on('error', () => socket.close()); socket.on('close', () => sockets.delete(socket));
  });
  return {
    app, server, store, tools, state,
    async close() {
      if (closed) return; closed = true; clearTimeout(noticeTimer); runtime?.close();
      for (const pending of captures.values()) { clearTimeout(pending.timer); pending.reject(new Error('Application closed.')); } captures.clear();
      persist(); for (const socket of sockets) socket.terminate(); wss.close();
      await new Promise<void>(resolveClose => { if (!server.listening) return resolveClose(); server.close(() => resolveClose()); server.closeAllConnections(); }); store.close();
    },
  };
}
