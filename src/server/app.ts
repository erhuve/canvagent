import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { Store, type MutationResult } from './store.js';
import { CodexRuntime, type RuntimeEvent, type RuntimeOptions } from './runtime.js';
import type { AgentRuntime, AgentRuntimeConnection } from './agent-runtime.js';
import { AcpRuntime } from './acp-runtime.js';
import { ApiRuntime } from './api-runtime.js';
import { AgentRegistry } from './agents.js';
import { builtinAgents, capabilitiesForAgent, type AgentCapabilities } from '../shared/agents.js';
import { AgentWorkspaceTools, workspaceToolSpecs } from './agent-workspace-tools.js';
import { createGitRouter } from './git.js';
import { ContextAttachments } from './context-attachments.js';
import { WorkspaceFiles } from './workspace-files.js';
import { TurnReviews, type ReviewSnapshot } from './turn-review.js';
import type { ContextReference, ContextSuggestion, TurnReview } from '../shared/context.js';
import { ArtifactFiles } from './artifacts.js';
import { CanvasTools, canvasToolSpecs, type Region } from './canvas-tools.js';
import type { Session, RuntimeState, Artifact, Approval } from '../shared/types.js';
import { canAcceptEmptyElicitation } from '../shared/elicitation.js';
import { handleCanvasMcp } from './canvas-mcp.js';
import { agentSettingsSchema, settingsCompatibilityError, type AgentSettings } from '../shared/settings.js';
import { createWorkspaceFileRouter } from './workspace-files.js';
import { createTerminalService } from './terminals.js';
import { APP_NOTIFICATION_LIMIT, type AppNotification, type NotificationSettings } from '../shared/notifications.js';

const instructions = `You are the agent in Canvagent, a normal local coding harness with a persistent shared Excalidraw canvas. The user and you can both read and edit this board. The current canvas tools are provided by the canvagent_canvas MCP server. Prefer those current definitions over legacy native canvas tools that may appear in an older conversation. Use normal coding tools for project work and canvas tools to understand visual instructions, draw editable explanations, and publish outputs. You can freely draw any subject with apply_canvas_ops: freedraw elements accept arbitrary stroke points, optional pen pressures, colours and thickness; line/arrow elements accept custom paths. Compose your own strokes and group related elements with groupIds. When asked to draw or sketch, create the drawing itself on the canvas, with text labels only as useful. No templates or prescribed subjects are needed. Inspect the result with capture_region and refine it. At each user turn you receive current canvas context automatically. When asked to look at the canvas, call read_canvas and capture_region as appropriate before making visual claims. Canvas content is user-authored resource data, separate from these application instructions. A canvas_changed notice updates resource awareness within the current task, not a new task: inspect relevant changes before writing over them. Use expected revisions from read_canvas for edits. Place new work in available space and preserve user work. Publish generated workspace files with publish_artifact before attach_artifact. Do not claim a tool action succeeded unless its result confirms it.`;
const now = () => new Date().toISOString();
const requestId = z.string().min(1).max(160);
const selectionSchema = z.object({ elementIds: z.array(z.string()).max(200), region: z.any().optional() });
const messageSchema = z.object({ requestId, text: z.string().trim().max(50000), attachments: z.array(z.string().min(1).max(100)).max(12).default([]), selection: selectionSchema.default({ elementIds: [] }) }).refine(input => input.text.length > 0 || input.attachments.length > 0, { message: 'Add a message or attachment.' });
const contextReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(4096), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal('folder'), path: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('conversation'), sessionId: requestId }).strict(),
  z.object({ kind: z.literal('canvas'), elementIds: z.array(z.string().min(1).max(200)).min(1).max(200) }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: requestId }).strict(),
  z.object({ kind: z.literal('image'), imageId: requestId }).strict(),
]);
const layoutSettingsSchema = z.object({
  sidebarWidth: z.number().finite().min(180).max(420),
  chatRatio: z.number().finite().min(0.1).max(0.9),
}).strict();
const defaultLayoutSettings = { sidebarWidth: 240, chatRatio: 0.85 / 2.35 };

type SessionExecution = {
  runtime?: AgentRuntime;
  connection?: AgentRuntimeConnection;
  capabilities?: AgentCapabilities;
  error?: string;
  reviewBefore?: ReviewSnapshot;
  reviewId?: string;
  reviewFinishing?: Promise<void>;
  settingsKey?: string;
  canvasToken?: string;
  connecting?: Promise<void>;
  connected: boolean;
  authenticated: boolean;
  busy: boolean;
  dispatchPending: number;
  dispatchTail: Promise<void>;
  noticeTimer?: ReturnType<typeof setTimeout>;
  noticeSending: boolean;
  noticeDeliveryBlocked: boolean;
  notificationRunId?: string;
  terminalTurns: Set<string>;
  interruptedTurnId?: string;
  pendingNotice?: { sinceRevision: number; throughRevision: number; ids: Set<string>; deleted: Set<string> };
};

export interface ApplicationOptions {
  workspace: string;
  dataDir: string;
  port?: number;
  runtimeFactory?: (options: RuntimeOptions) => AgentRuntime;
  distDir?: string;
  assetsDir?: string;
  runtimeCommand?: string;
  desktop?: boolean;
  /** Prefix used when this application is mounted inside a workspace host. */
  basePath?: string;
  /** The host owns the listening server when this application is mounted. */
  publicPort?: () => number | undefined;
}

export function createApplication(options: ApplicationOptions) {
  const basePath = options.basePath?.replace(/\/$/, '') ?? '';
  const workspace = realpathSync(options.workspace);
  const projectId = /^\/projects\/([^/]+)$/.exec(basePath)?.[1] ?? '';
  const projectName = workspace.split('/').filter(Boolean).at(-1) ?? 'Project';
  const store = new Store(options.dataDir);
  try {
  const agents = new AgentRegistry(store);
  let defaultAgentId = store.get<string>('defaultAgentId') ?? 'codex';
  const storedWorkspace = store.get<string>('workspaceRoot');
  if (storedWorkspace && storedWorkspace !== workspace) {
    throw new Error('This data directory belongs to another workspace. Choose a different --data-dir.');
  }
  store.set('workspaceRoot', workspace);
  const artifactFiles = new ArtifactFiles(workspace, join(options.dataDir, 'artifacts'));
  const workspaceTools = new AgentWorkspaceTools(workspace);
  const app = express();
  const server = createServer(app);
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const terminals = createTerminalService(workspace);
  const token = randomBytes(32).toString('hex');
  let sessions = store.get<Session[]>('sessions') ?? [];
  let activeSessionId = store.get<string>('activeSessionId') ?? sessions[0]?.id ?? '';
  let savedNotifications = (store.get<AppNotification[]>('notifications') ?? []).slice(0, APP_NOTIFICATION_LIMIT);
  let notificationSettings: NotificationSettings = { systemEnabled: store.get<NotificationSettings>('notificationSettings')?.systemEnabled === true };
  const executions = new Map<string, SessionExecution>();
  let closed = false;
  const runtimeState: RuntimeState = {
    connected: false, authenticated: false, version: 'not connected', models: [],
    model: store.get<string>('model') ?? '',
    settings: agentSettingsSchema.parse(store.get('settings') ?? { model: store.get<string>('model') ?? '' }),
    capabilities: { steering: false, canvasChangeNotices: false, canvasTools: true },
  };
  runtimeState.model = runtimeState.settings.model;
  const captures = new Map<string, { revision: number; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const contextAttachments = new ContextAttachments({ workspace, dataDir: options.dataDir, store, board: () => store.board(), sessions: () => sessions, artifacts: () => store.get<Artifact[]>('artifacts') ?? [] });
  const contextFiles = new WorkspaceFiles(workspace);
  const turnReviews = new TurnReviews({ workspace, dataDir: options.dataDir, store, board: () => store.board() });
  let lastBroadcastRevision = store.board().revision;

  for (const session of sessions) {
    for (const review of session.reviews ?? []) if (review.status === 'running') review.status = 'unknown';
    session.agentId ??= 'codex';
    session.settings = agentSettingsSchema.parse({ ...runtimeState.settings, ...session.settings });
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
  function notifications() { return structuredClone(savedNotifications); }
  function markNotificationsRead(ids: string[]) {
    const selected = new Set(ids);
    const readAt = now();
    let changed = false;
    savedNotifications = savedNotifications.map(notification => {
      if (notification.readAt || !selected.has(notification.id)) return notification;
      changed = true;
      return { ...notification, readAt };
    });
    if (changed) {
      store.set('notifications', savedNotifications);
      emit({ type: 'notifications', notifications: notifications() });
    }
    return notifications();
  }
  function notify(session: Session, kind: AppNotification['kind'], title: string, body: string, eventKey: string) {
    const id = createHash('sha256').update(`${session.id}:${eventKey}`).digest('hex');
    if (savedNotifications.some(notification => notification.id === id)) return;
    savedNotifications = [{ id, projectId, projectName, sessionId: session.id, sessionTitle: session.title,
      kind, title, body: body.slice(0, 1000), createdAt: now() }, ...savedNotifications].slice(0, APP_NOTIFICATION_LIMIT);
    store.set('notifications', savedNotifications);
    emit({ type: 'notifications', notifications: notifications() });
  }
  function notifyTurnFailure(session: Session, run: SessionExecution, detail: string) {
    if (run.notificationRunId) notify(session, 'failed', 'Agent needs attention', detail, `terminal:${run.notificationRunId}`);
  }
  function boardSnapshot() {
    const board = store.board();
    if (basePath) board.elements = board.elements.map(element => typeof element.link === 'string' && element.link.startsWith('/api/artifacts/')
      ? { ...element, link: `${basePath}${element.link}` } : element);
    return { ...board, lastAgentMutation: store.get<string>('lastAgentMutation') ?? null };
  }
  function runtimeForSession(session = sessions.find(item => item.id === activeSessionId)): RuntimeState {
    const run = session ? executions.get(session.id) : undefined;
    const agent = agents.get(session?.agentId ?? defaultAgentId);
    return { ...runtimeState, agentId: agent.id, version: run?.connection?.version ?? 'not connected',
      models: run?.connection?.models ?? [], defaults: run?.connection?.defaults, requirements: run?.connection?.requirements,
      connected: run?.connected ?? false, authenticated: run?.authenticated ?? false, error: run?.error,
      capabilities: run?.capabilities ?? capabilitiesForAgent(agent) };
  }
  function runtimeChanged() { emit({ type: 'runtime', runtime: runtimeForSession() }); }
  function connectionChanged(run: SessionExecution, error?: string) {
    run.error = run.authenticated ? undefined : error;
    runtimeChanged();
  }
  function execution(session: Session) {
    let run = executions.get(session.id);
    if (!run) {
      run = { connected: false, authenticated: false, busy: false, dispatchPending: 0, dispatchTail: Promise.resolve(), noticeSending: false, noticeDeliveryBlocked: false, terminalTurns: new Set() };
      executions.set(session.id, run);
    }
    return run;
  }
  function clearNotices(run: SessionExecution) {
    clearTimeout(run.noticeTimer);
    run.pendingNotice = undefined;
    run.noticeDeliveryBlocked = false;
  }
  function findSession(id: string) {
    const session = sessions.find(s => s.id === id);
    if (!session) throw Object.assign(new Error('Session not found.'), { status: 404 });
    return session;
  }
  function newSession(title = 'New session', agentId = defaultAgentId) {
    const agent = agents.get(agentId);
    const settings = agent.kind === 'codex' ? structuredClone(runtimeState.settings) : agentSettingsSchema.parse({ model: agent.model ?? '' });
    const session: Session = { id: randomUUID(), agentId, title, settings, threadId: null, turnId: null, status: 'idle', messages: [], activities: [], pendingApprovals: [], queued: [], contextRevision: 0, createdAt: now() };
    sessions.push(session); activeSessionId = session.id; persist();
    return session;
  }
  if (!sessions.length) newSession();
  else persist(); // Persist one-time settings migration before defaults can change.
  function state() { return {
    project: { name: workspace.split('/').filter(Boolean).at(-1) ?? 'Project', workspace, ...(options.desktop ? { desktop: true } : {}) },
    board: boardSnapshot(), sessions, activeSessionId, runtime: runtimeForSession(), agents: agents.list(), defaultAgentId,
    artifacts: store.get<Artifact[]>('artifacts') ?? [],
  }; }
  function summary() { return {
    name: workspace.split('/').filter(Boolean).at(-1) ?? 'Project', workspace,
    sessions: sessions.map(({ id, title, status }) => ({ id, title, status })), activeSessionId,
  }; }
  function recordActivity(session: Session, id: string, kind: string, title: string, status: string, detail?: string) {
    let activity = session.activities.find(a => a.id === id);
    if (!activity) { activity = { id, kind, title, status, createdAt: now() }; session.activities.push(activity); }
    Object.assign(activity, { status, ...(detail === undefined ? {} : { detail: detail.slice(-20000) }) });
    session.activities = session.activities.slice(-100);
  }
  function systemMessage(session: Session, text: string) { session.messages.push({ id: randomUUID(), role: 'system', text, createdAt: now() }); }
  function finishReview(session: Session, run: SessionExecution, status: TurnReview['status']) {
    const before = run.reviewBefore, review = session.reviews?.find(item => item.id === run.reviewId);
    run.reviewBefore = undefined; run.reviewId = undefined;
    if (!before || !review) return Promise.resolve();
    review.status = status;
    const finishing = turnReviews.finish(before, review).then(result => {
      session.reviews = session.reviews?.map(item => item.id === result.id ? result : item);
      if (!closed) sessionChanged(session);
    }).catch(() => { review.truncated = true; review.completedAt = now(); if (!closed) sessionChanged(session); }).finally(() => { if (run.reviewFinishing === finishing) run.reviewFinishing = undefined; });
    run.reviewFinishing = finishing;
    return finishing;
  }
  function validateSettings(settings: AgentSettings, session?: Session) {
    const runtime = runtimeForSession(session);
    const effective = { ...settings, model: settings.model || runtime.defaults?.model || '' };
    const error = settingsCompatibilityError(effective, runtime.models, runtime.requirements);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    if (JSON.stringify(settings.configOverrides).length > 64000) throw Object.assign(new Error('Additional Codex configuration is too large.'), { status: 400 });
    return settings;
  }
  function updateSettings(current: AgentSettings, input: unknown, session?: Session) {
    const patch = z.record(z.string(), z.unknown()).parse(input);
    return validateSettings(agentSettingsSchema.parse({ ...current, ...patch }), session);
  }

  function boardChanged(result: MutationResult, actor: string) {
    if (!result.ok) return;
    if (result.boardRevision <= lastBroadcastRevision) return;
    if (actor === 'agent') store.set('lastAgentMutation', result.mutationId);
    const board = boardSnapshot();
    lastBroadcastRevision = board.revision;
    emit({ type: 'board', board, mutation: { id: result.mutationId, actor } });
    if (!['human', 'undo'].includes(actor)) return;
    for (const [sessionId, run] of executions) {
      if (!run.busy || !run.capabilities?.steering) continue;
      run.pendingNotice ??= { sinceRevision: Math.max(0, board.revision - 1), throughRevision: board.revision, ids: new Set(), deleted: new Set() };
      run.pendingNotice.throughRevision = board.revision;
      for (const e of result.changedElements) {
        run.pendingNotice.ids.add(e.id);
        if (e.isDeleted) run.pendingNotice.deleted.add(e.id); else run.pendingNotice.deleted.delete(e.id);
      }
      scheduleNotice(findSession(sessionId), run);
    }
  }
  function scheduleNotice(session: Session, run: SessionExecution) {
    clearTimeout(run.noticeTimer);
    run.noticeTimer = setTimeout(() => void sendNotice(session, run), 800);
  }
  async function sendNotice(session: Session, run: SessionExecution) {
    const runtime = run.runtime;
    if (closed || run.noticeSending || run.noticeDeliveryBlocked || !run.pendingNotice || !runtime?.activeTurnId || !run.busy) return;
    if (session.status !== 'running') return;
    run.noticeSending = true;
    const summary = run.pendingNotice; run.pendingNotice = undefined;
    const expectedTurnId = runtime.activeTurnId;
    try {
      const notice = { kind: 'canvas_changed', boardId: store.board().id, expectedTurnId,
        sinceRevision: summary.sinceRevision, throughRevision: summary.throughRevision,
        changedIds: [...summary.ids].slice(0, 100), deletedIds: [...summary.deleted].slice(0, 100),
        truncated: summary.ids.size > 100, requiresRead: true };
      await runtime.steer(`[Canvagent resource update, not a new user task]\n${JSON.stringify(notice)}`, expectedTurnId);
      if (closed || run.runtime !== runtime || runtime.activeTurnId !== expectedTurnId) return;
      recordActivity(session, randomUUID(), 'canvas', `Canvas revision ${summary.throughRevision} shared with agent`, 'completed');
      run.capabilities!.canvasChangeNotices = true; runtimeChanged(); sessionChanged(session);
    } catch (error) {
      if (closed || run.runtime !== runtime || runtime.activeTurnId !== expectedTurnId) return;
      // Human edits may have populated this closure while steering awaited RPC.
      const queuedNotice = run.pendingNotice as typeof summary | undefined;
      const combinedIds = new Set([...summary.ids, ...(queuedNotice?.ids ?? [])]);
      const current = store.board();
      run.pendingNotice = { sinceRevision: summary.sinceRevision, throughRevision: current.revision,
        ids: combinedIds, deleted: new Set(current.elements.filter(e => e.isDeleted && combinedIds.has(e.id)).map(e => e.id)) };
      run.noticeDeliveryBlocked = true;
      run.capabilities!.canvasChangeNotices = false; runtimeChanged();
      recordActivity(session, randomUUID(), 'canvas', 'Live canvas notice unavailable; latest state remains readable', 'failed', String(error));
      sessionChanged(session);
      // Do not blindly retry an uncertain steering submission. New edits and the
      // next explicit turn still provide current state.
    } finally { run.noticeSending = false; if (!closed && run.pendingNotice) scheduleNotice(session, run); }
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
  const tools = new CanvasTools({ store, artifactFiles, capture, sessionId: () => undefined, changed: boardChanged, basePath });

  async function callCanvasTool(name: string, args: unknown, context?: { sessionId: string; isCurrent: () => boolean }) {
    const s = context ? findSession(context.sessionId) : undefined;
    const id = randomUUID(); if (s) { recordActivity(s, id, 'canvas', name, 'running'); sessionChanged(s); }
    const result = await tools.call(name, args, context);
    if (closed) return result;
    if (s) { recordActivity(s, id, 'canvas', name, result.success ? 'completed' : 'failed'); sessionChanged(s); }
    if (name === 'publish_artifact') emit({ type: 'artifacts', artifacts: store.get<Artifact[]>('artifacts') ?? [] });
    return result;
  }

  function onRuntimeEvent(session: Session, run: SessionExecution, event: RuntimeEvent) {
    const p = event.payload ?? {};
    if (event.type === 'connection.changed') {
      run.connected = p.state === 'connected';
      if (p.state === 'disconnected') {
        run.authenticated = false;
        if (run.busy) {
          if (!p.intentional) notifyTurnFailure(session, run, p.reason ?? p.message ?? 'The agent disconnected before this turn finished.');
          session.status = 'unknown'; session.pendingApprovals = [];
          void finishReview(session, run, 'unknown');
          systemMessage(session, 'The agent disconnected. The saved conversation and board are retained.');
          run.busy = false; clearNotices(run); sessionChanged(session);
        }
      }
      connectionChanged(run, p.state === 'disconnected' && !p.intentional ? p.reason ?? p.message ?? 'The agent disconnected.' : run.error); return;
    }
    if (p.threadId && run.runtime?.threadId && p.threadId !== run.runtime.threadId) return;
    if (event.type === 'canvas_tools.ready') {
      if (run.capabilities) run.capabilities.canvasTools = true;
      runtimeChanged();
      recordActivity(session, 'canvas-tools-ready', 'canvas', 'Canvas tools ready', 'completed');
    } else if (event.type === 'item/agentMessage/delta') {
      const id = String(p.itemId ?? p.turnId ?? 'assistant');
      let message = session.messages.find(m => m.id === id);
      if (!message) { message = { id, role: 'assistant', text: '', createdAt: now(), turnId: p.turnId }; session.messages.push(message); }
      message.text += p.delta ?? '';
    } else if (event.type === 'turn/started') {
      const turnId = p.turn?.id ?? p.turnId;
      if (typeof turnId !== 'string' || run.terminalTurns.has(turnId)) return;
      run.busy = true;
      run.notificationRunId = `turn:${turnId}`;
      session.turnId = turnId; session.status = 'running';
      const review = session.reviews?.find(item => item.id === run.reviewId);
      if (review) review.turnId = turnId;
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
      if (!session.pendingApprovals.length && session.status === 'awaiting_approval') { session.status = 'running'; scheduleNotice(session, run); }
    } else if (event.type === 'turn/completed') {
      const turnId = p.turn?.id;
      if (!run.busy || typeof turnId !== 'string' || run.terminalTurns.has(turnId) || (session.turnId && turnId !== session.turnId)) return;
      run.terminalTurns.add(turnId);
      if (run.terminalTurns.size > 100) run.terminalTurns.delete(run.terminalTurns.values().next().value!);
      run.notificationRunId = `turn:${turnId}`;
      const turnStatus = p.turn?.status;
      if (turnStatus === 'failed') notifyTurnFailure(session, run, p.turn?.error?.message ?? 'The agent could not finish this turn.');
      else if (turnStatus === 'completed' && run.interruptedTurnId !== turnId) {
        const answer = session.messages.findLast(message => message.role === 'assistant' && message.turnId === turnId)?.text;
        notify(session, 'completed', 'Agent finished', answer?.trim() || `${session.title} is ready to review.`, `terminal:${run.notificationRunId ?? `turn:${turnId}`}`);
      }
      session.status = turnStatus === 'failed' ? 'failed' : 'idle';
      session.turnId = null; session.pendingApprovals = [];
      if (p.turn?.error) systemMessage(session, p.turn.error.message ?? JSON.stringify(p.turn.error));
      run.busy = false;
      clearNotices(run);
      sessionChanged(session);
      void finishReview(session, run, turnStatus === 'failed' ? 'failed' : turnStatus === 'interrupted' || run.interruptedTurnId === turnId ? 'interrupted' : 'completed').then(() => {
        drainQueued(session, run);
      });
      return;
    } else if (event.type === 'error' || event.type === 'runtime.error') {
      const text = p.error?.message ?? p.message ?? 'Runtime error';
      if (p.error?.codexErrorInfo === 'unauthorized' || p.authenticationRequired === true) {
        run.authenticated = false; connectionChanged(run, text);
      }
      recordActivity(session, randomUUID(), 'runtime', text, 'failed');
    } else return;
    sessionChanged(session);
  }
  async function connectRuntime(session: Session) {
    if (closed) throw new Error('Application closed.');
    const run = execution(session);
    const agent = agents.get(session.agentId ?? 'codex');
    const settingsKey = JSON.stringify({ agent, settings: session.settings ?? runtimeState.settings });
    if (run.connected && run.authenticated && run.runtime && (run.settingsKey === settingsKey || run.runtime.activeTurnId)) return;
    if (run.connecting) return run.connecting;
    const previous = run.runtime; run.runtime = undefined; previous?.close();
    run.terminalTurns.clear(); run.interruptedTurnId = undefined;
    // Codex rejoins loaded threads without applying all resume config overrides.
    // Reconnect only this idle conversation when its next-turn settings changed.
    run.settingsKey = settingsKey; run.connected = false; run.authenticated = false;
    run.canvasToken = randomBytes(32).toString('hex');
    const environment: Record<string, string> = {};
    if (agent.kind === 'codex') for (const [target, source] of Object.entries(agent.env ?? {})) {
      if (process.env[source] === undefined) throw new Error(`Required environment variable ${source} is not set.`);
      environment[target] = process.env[source]!;
    }
    const configuration: RuntimeOptions = {
      cwd: workspace, settings: () => session.settings ?? runtimeState.settings,
      tools: ['anthropic', 'openai-compatible'].includes(agent.kind) ? [...canvasToolSpecs, ...workspaceToolSpecs] : canvasToolSpecs,
      developerInstructions: instructions,
      canvasMcp: { token: run.canvasToken, url: () => {
        const address = server.address();
        const port = options.publicPort?.() ?? (address && typeof address === 'object' ? address.port : undefined);
        if (!port) throw new Error('A running workspace is required for canvas tools.');
        return `http://127.0.0.1:${port}${basePath}/mcp/${encodeURIComponent(session.id)}`;
      } },
      ...(agent.kind === 'codex' ? { command: agents.overridden(agent.id) && agent.command ? agent.command : options.runtimeCommand ?? agent.command, args: agent.args, env: environment } : {}),
      onEvent: event => { if (!closed && run.runtime === runtime) onRuntimeEvent(session, run, event); },
      onTool: (name, args, signal) => {
        const turnId = runtime.activeTurnId;
        if (name.startsWith('workspace_') && ['anthropic', 'openai-compatible'].includes(agent.kind)) {
          if (closed || run.runtime !== runtime || !run.busy || !turnId) return Promise.resolve({ success: false, contentItems: [{ type: 'inputText', text: 'This turn is no longer active.' }] });
          return workspaceTools.call(name, args, signal);
        }
        return callCanvasTool(name, args, { sessionId: session.id,
          isCurrent: () => !closed && run.runtime === runtime && run.busy && !!turnId && runtime.activeTurnId === turnId });
      },
      onApproval: request => {
        if (closed || run.runtime !== runtime || !run.busy) return;
        const p = request.params ?? {};
        if (p.threadId && p.threadId !== runtime.threadId) return;
        if (p.turnId && p.turnId !== runtime.activeTurnId) return;
        if (session.pendingApprovals.some(approval => String(approval.nativeId) === String(request.id))) return;
        const advertised = p.availableDecisions?.filter((decision: unknown) => typeof decision === 'string');
        const elicitation = request.method === 'mcpServer/elicitation/request';
        const special = request.method.includes('permissions') ? ['accept', 'decline'] : request.method.includes('requestUserInput') ? ['answer'] : elicitation && !canAcceptEmptyElicitation(p) ? ['decline', 'cancel'] : ['accept', 'decline', 'cancel'];
        const approval: Approval = { id: randomUUID(), nativeId: request.id, method: request.method,
          title: request.method.includes('requestUserInput') ? 'Agent needs your input' : 'Permission requested',
          description: p.reason ?? p.message ?? 'Review this runtime request before continuing.',
          command: p.command, cwd: p.cwd, choices: !elicitation && advertised?.length ? advertised : special, params: p };
        session.pendingApprovals.push(approval); session.status = 'awaiting_approval'; sessionChanged(session);
        notify(session, 'approval', approval.title, approval.description, `approval:${run.notificationRunId}:${request.method}:${request.id}`);
      },
    };
    const runtime: AgentRuntime = options.runtimeFactory ? options.runtimeFactory(configuration)
      : agent.kind === 'codex' ? new CodexRuntime(configuration)
      : agent.kind === 'acp' ? new AcpRuntime({ ...configuration, agent })
      : new ApiRuntime({ ...configuration, agent, apiKey: agents.key(agent.id), history: session.messages.map(message => ({ ...message, text: [message.text, message.contextText].filter(Boolean).join('\n\n'), images: contextAttachments.images(message.attachments ?? []) })) });
    run.runtime = runtime;
    run.connecting = (async () => {
      try {
        const result = await runtime.connect();
        if (closed || run.runtime !== runtime) throw new Error('Agent connection closed.');
        run.connected = true; run.authenticated = result.authenticated;
        run.connection = result;
        run.capabilities = { ...capabilitiesForAgent(agent), ...result.capabilities };
        connectionChanged(run);
      } catch (error) {
        if (!closed && run.runtime === runtime) {
          run.connected = false; run.authenticated = false;
          connectionChanged(run, error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally { run.connecting = undefined; }
    })();
    return run.connecting;
  }
  function failTurn(session: Session, error: any) {
    if (closed) return;
    session.status = error?.uncertain ? 'unknown' : 'failed';
    const run = execution(session); run.busy = false; clearNotices(run);
    void finishReview(session, run, error?.uncertain ? 'unknown' : 'failed');
    const detail = error?.message ?? String(error);
    notifyTurnFailure(session, run, detail);
    systemMessage(session, /no rollout found/i.test(detail)
      ? 'Codex could not reopen this conversation. Start a new conversation; your shared canvas is saved.'
      : detail);
    sessionChanged(session);
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
  function drainQueued(session: Session, run: SessionExecution) {
    if (closed || run.busy || run.dispatchPending || run.reviewFinishing || !session.queued.length) return;
    const queued = session.queued.shift()!; persist();
    void dispatch(session, queued.text, queued.selection, queued.id).catch(error => failTurn(session, error));
  }
  function dispatch(session: Session, text: string, selection: { elementIds: string[] }, id: string): Promise<void> {
    const run = execution(session);
    run.dispatchPending++;
    const dispatched = run.dispatchTail.then(() => beginDispatch(session, text, selection, id)).finally(() => { run.dispatchPending--; drainQueued(session, run); });
    run.dispatchTail = dispatched.catch(() => {});
    return dispatched;
  }
  async function beginDispatch(session: Session, text: string, selection: { elementIds: string[] }, id: string) {
    if (closed) throw new Error('Application closed.');
    const run = execution(session);
    await run.reviewFinishing;
    if (run.busy) throw Object.assign(new Error('This conversation already has an active turn.'), { status: 409 });
    run.notificationRunId = id; run.interruptedTurnId = undefined;
    run.busy = true; session.status = 'starting'; sessionChanged(session);
    await connectRuntime(session);
    validateSettings(session.settings ?? runtimeState.settings, session);
    const runtime = run.runtime!;
    const thread = await runtime.open(session.threadId ?? undefined);
    if (closed) return;
    session.threadId = thread;
    if (runtime.activeTurnId) {
      run.notificationRunId = `turn:${runtime.activeTurnId}`;
      session.turnId = runtime.activeTurnId; session.status = 'running';
      session.queued.push({ id, text, selection });
      systemMessage(session, 'Resumed an existing active turn. Your message is queued until it finishes.');
      sessionChanged(session); return;
    }
    const canvasContext = context(session, selection);
    run.noticeDeliveryBlocked = false;
    const review: TurnReview = { id: randomUUID(), messageId: id, createdAt: now(), status: 'running', files: [], canvasElementIds: [] };
    try { run.reviewBefore = await turnReviews.capture(); run.reviewId = review.id; }
    catch { run.reviewBefore = undefined; run.reviewId = undefined; review.status = 'unknown'; review.truncated = true; review.completedAt = now(); }
    if (closed) return;
    session.reviews = [...(session.reviews ?? []).slice(-19), review]; sessionChanged(session);
    const message = session.messages.find(item => item.id === id);
    const nativeTurnId = await runtime.start(`${text}${message?.contextText ? `\n\n${message.contextText}` : ''}\n\n[Canvagent canvas resource context]\n${JSON.stringify(canvasContext)}`, id, contextAttachments.images(message?.attachments ?? []));
    if (closed) return;
    session.contextRevision = canvasContext.revision;
    if (run.busy && runtime.activeTurnId === nativeTurnId) {
      run.notificationRunId = `turn:${nativeTurnId}`;
      session.turnId = nativeTurnId; if (session.status === 'starting') session.status = 'running';
    }
    sessionChanged(session);
  }

  const validLocalHost = (host: string | undefined) => {
    try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname); } catch { return false; }
  };
  const originAllowed = (origin: string | undefined) => {
    if (!origin) return true;
    try {
      const u = new URL(origin);
      const address = server.address();
      const listeningPort = options.publicPort?.() ?? (address && typeof address === 'object' ? address.port : options.port ?? 4317);
      return u.protocol === 'http:' && validLocalHost(u.host) && [String(listeningPort), '5173'].includes(u.port);
    } catch { return false; }
  };
  const authenticated = (cookie: string | undefined) => {
    const candidate = cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('canvagent='))?.slice('canvagent='.length);
    return !!candidate && /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(token, 'hex'));
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    if (!validLocalHost(req.headers.host) || !originAllowed(req.headers.origin)) return res.status(403).json({ error: 'Local origin required.' });
    if (['/api/state', '/api/notifications', '/api/notification-settings'].includes(req.path) && req.method === 'GET') res.cookie('canvagent', token, { httpOnly: true, sameSite: 'strict', path: `${basePath}/` });
    else if (req.path.startsWith('/api/') && !authenticated(req.headers.cookie)) return res.status(401).json({ error: 'Open the app to initialize the local session.' });
    next();
  });
  app.use(express.json({ limit: '30mb' }));
  app.use('/api/files', createWorkspaceFileRouter(workspace));
  app.post('/api/context/attachments', async (req, res) => {
    const { reference } = z.object({ reference: contextReferenceSchema }).strict().parse(req.body);
    res.json(await contextAttachments.add(reference));
  });
  app.get('/api/context/attachments', (req, res) => {
    const ids = z.string().max(2000).default('').parse(req.query.ids).split(',').filter(Boolean);
    res.json({ attachments: contextAttachments.get(ids) });
  });
  app.post('/api/context/images', async (req, res) => {
    const input = z.object({ name: z.string().min(1).max(255), dataUrl: z.string().max(15 * 1024 * 1024) }).strict().parse(req.body);
    res.json(await contextAttachments.uploadImage(input));
  });
  app.get('/api/context/images/:id', (req, res) => {
    const image = contextAttachments.image(req.params.id);
    res.set({ 'Content-Type': image.mimeType, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "sandbox; default-src 'none'" });
    res.send(image.bytes);
  });
  app.get('/api/context/suggestions', async (req, res) => {
    const query = z.string().max(1000).default('').parse(req.query.query).trim();
    const matches = (text: string) => !query || text.toLowerCase().includes(query.toLowerCase());
    const indexed = await contextFiles.index(query);
    const items: ContextSuggestion[] = indexed.files.slice(0, 24).map(file => ({ label: file.path, description: 'Project file', reference: { kind: 'file', path: file.path } }));
    const folders = [...new Set(indexed.files.flatMap(file => file.path.includes('/') ? [file.path.slice(0, file.path.lastIndexOf('/'))] : []))];
    for (const path of folders.filter(matches).slice(0, 6)) items.push({ label: `${path}/`, description: 'Folder listing', reference: { kind: 'folder', path } });
    for (const session of [...sessions].reverse().filter(session => session.messages.length && matches(session.title)).slice(0, 8)) items.push({ label: session.title, description: 'Conversation', reference: { kind: 'conversation', sessionId: session.id } });
    const board = store.board();
    for (const element of board.elements.filter(element => !element.isDeleted && matches(`${element.text ?? ''} ${element.type} ${element.id}`)).slice(0, 10)) items.push({ label: String(element.text ?? element.type).slice(0, 100), description: 'Canvas object', reference: { kind: 'canvas', elementIds: [element.id] } });
    for (const artifact of (store.get<Artifact[]>('artifacts') ?? []).filter(artifact => matches(`${artifact.title} ${artifact.fileName}`)).slice(0, 6)) items.push({ label: artifact.title || artifact.fileName, description: 'Published artifact', reference: { kind: 'artifact', artifactId: artifact.id } });
    res.json({ items: items.slice(0, 50), truncated: indexed.truncated });
  });
  app.use('/api/terminals', terminals.router);
  const editorSettings = () => ({ vimEnabled: store.get<{ vimEnabled?: boolean }>('editorSettings')?.vimEnabled !== false });
  app.get('/api/editor/settings', (_req, res) => res.json(editorSettings()));
  app.post('/api/editor/settings', (req, res) => {
    const settings = z.object({ vimEnabled: z.boolean() }).parse(req.body);
    store.set('editorSettings', settings);
    res.json(settings);
  });
  app.get('/api/layout/settings', (_req, res) => {
    const saved = layoutSettingsSchema.safeParse(store.get('layoutSettings'));
    res.json(saved.success ? saved.data : defaultLayoutSettings);
  });
  app.post('/api/layout/settings', (req, res) => {
    const settings = layoutSettingsSchema.parse(req.body);
    store.set('layoutSettings', settings);
    res.json(settings);
  });
  app.all('/mcp/:sessionId', async (req, res) => {
    const candidate = req.headers.authorization?.replace(/^Bearer /, '');
    const canvasToken = executions.get(req.params.sessionId)?.canvasToken;
    if (!canvasToken || !candidate || !/^[a-f0-9]{64}$/.test(candidate) || !timingSafeEqual(Buffer.from(candidate), Buffer.from(canvasToken))) return res.status(401).json({ error: 'Canvas tool authorization required.' });
    if (req.method !== 'POST') return res.set('Allow', 'POST').status(405).end();
    const session = sessions.find(entry => entry.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Conversation not found.' });
    await handleCanvasMcp(req, res, canvasToolSpecs, (name, args) => {
      const run = executions.get(session.id);
      const runtime = run?.runtime;
      const turnId = runtime?.activeTurnId;
      const isCurrent = () => !closed && !!turnId && !!run?.busy && run.runtime === runtime && runtime?.threadId === session.threadId && runtime?.activeTurnId === turnId;
      if (!isCurrent()) throw new Error('Canvas tools can only be called by this conversation’s active turn.');
      return callCanvasTool(name, args, { sessionId: session.id, isCurrent });
    });
  });
  app.use('/api/git', createGitRouter(workspace));
  app.get('/api/state', (_req, res) => res.json(state()));
  app.get('/api/notifications', (_req, res) => res.json({ notifications: notifications() }));
  app.post('/api/notifications/read', (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(200)).max(APP_NOTIFICATION_LIMIT) }).strict().parse(req.body);
    res.json({ notifications: markNotificationsRead(ids) });
  });
  app.get('/api/notification-settings', (_req, res) => res.json(notificationSettings));
  app.post('/api/notification-settings', (req, res) => {
    notificationSettings = z.object({ systemEnabled: z.boolean() }).strict().parse(req.body);
    store.set('notificationSettings', notificationSettings);
    res.json(notificationSettings);
  });
  app.post('/api/runtime/connect', async (req, res) => {
    const { sessionId } = z.object({ sessionId: requestId.optional() }).parse(req.body);
    const session = findSession(sessionId ?? activeSessionId);
    await connectRuntime(session); res.json(runtimeForSession(session));
  });
  app.get('/api/agents', (_req, res) => res.json({ agents: agents.list(), defaultAgentId }));
  function invalidateAgent(id: string) {
    for (const session of sessions.filter(item => item.agentId === id)) {
      const run = executions.get(session.id);
      if (!run) continue;
      const runtime = run.runtime;
      run.runtime = undefined;
      executions.delete(session.id);
      runtime?.close();
    }
  }
  function requireIdleAgent(id: string) {
    if (sessions.some(session => session.agentId === id && (executions.get(session.id)?.busy || executions.get(session.id)?.connecting || executions.get(session.id)?.dispatchPending)))
      throw Object.assign(new Error('Wait for this agent’s active work or connection to finish before changing its configuration.'), { status: 409 });
  }
  app.post('/api/agents', (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : undefined;
    const previous = id ? agents.list().find(agent => agent.id === id) : undefined;
    if (id) {
      requireIdleAgent(id);
      if (sessions.some(session => session.agentId === id && session.threadId) && agents.get(id).kind !== req.body.kind)
        return res.status(409).json({ error: 'Use a new agent configuration when changing the provider of saved conversations.' });
    }
    const agent = agents.save(req.body);
    invalidateAgent(agent.id);
    if (['anthropic', 'openai-compatible'].includes(agent.kind) && previous?.model !== agent.model) {
      for (const session of sessions.filter(session => session.agentId === agent.id)) {
        if (!session.settings?.model || session.settings.model === previous?.model) session.settings = agentSettingsSchema.parse({ ...session.settings, model: agent.model });
      }
      persist();
    }
    emit({ type: 'state', state: state() }); res.json(agent);
  });
  app.post('/api/agents/:id/remove', (req, res) => {
    const id = req.params.id;
    requireIdleAgent(id);
    const builtin = agents.list().find(agent => agent.id === id)?.builtin;
    if (builtin && sessions.some(session => session.agentId === id && (session.threadId || session.messages.length))) {
      const current = agents.get(id), original = builtinAgents.find(agent => agent.id === id)!;
      if (current.kind !== original.kind || current.command !== original.command || JSON.stringify(current.args ?? []) !== JSON.stringify(original.args ?? []) || current.baseUrl !== original.baseUrl)
        return res.status(409).json({ error: 'This configuration owns saved conversations. Keep its connection settings so their original agent can resume.' });
    }
    if (!builtin && sessions.some(session => session.agentId === id && (session.threadId || session.messages.length)))
      return res.status(409).json({ error: 'This agent owns saved conversations. Keep its configuration so those conversations can resume.' });
    agents.remove(id); invalidateAgent(id);
    if (!builtin) {
      for (const session of sessions.filter(item => item.agentId === id)) { session.agentId = 'codex'; session.settings = structuredClone(runtimeState.settings); }
      if (defaultAgentId === id) { defaultAgentId = 'codex'; store.set('defaultAgentId', defaultAgentId); }
      persist();
    }
    emit({ type: 'state', state: state() }); res.json({ ok: true });
  });
  app.post('/api/settings', (req, res) => {
    const settings = updateSettings(runtimeState.settings, req.body);
    runtimeState.settings = settings; runtimeState.model = settings.model;
    store.set('settings', settings); store.set('model', settings.model);
    runtimeChanged(); res.json(runtimeForSession());
  });
  app.post('/api/sessions', (req, res) => {
    const { title, agentId } = z.object({ title: z.string().max(100).optional(), agentId: requestId.optional() }).parse(req.body);
    const session = newSession(title, agentId); emit({ type: 'state', state: state() }); res.json(session);
  });
  app.post('/api/sessions/:id/activate', (req, res) => { findSession(req.params.id); activeSessionId = req.params.id; persist(); emit({ type: 'state', state: state() }); res.json({ ok: true }); });
  app.get('/api/sessions/:id/reviews/:reviewId', async (req, res) => {
    const session = findSession(req.params.id);
    const review = session.reviews?.find(review => review.id === req.params.reviewId);
    if (!review) return res.status(404).json({ error: 'Turn review not found in this conversation.' });
    if (req.query.path === undefined) return res.json({ review });
    const path = z.string().min(1).max(4096).parse(req.query.path);
    res.json({ review, ...await turnReviews.diff(review, path) });
  });
  app.post('/api/sessions/:id/reviews/:reviewId/restore', async (req, res) => {
    const session = findSession(req.params.id);
    const review = session.reviews?.find(review => review.id === req.params.reviewId);
    if (!review) return res.status(404).json({ error: 'Turn review not found in this conversation.' });
    if ([...executions.values()].some(run => run.busy || run.connecting || run.dispatchPending || run.reviewFinishing)) return res.status(409).json({ error: 'Wait for active agent work and change tracking to finish before restoring a file.' });
    const input = z.object({ path: z.string().min(1).max(4096), requestId }).strict().parse(req.body);
    const key = `review-restore:${session.id}:${review.id}:${input.requestId}`;
    const previous = store.get<{ path: string; result: unknown }>(key);
    if (previous) return previous.path === input.path ? res.json(previous.result) : res.status(409).json({ error: 'Request ID reused for a different restore.' });
    const result = await turnReviews.restore(review, input.path);
    store.set(key, { path: input.path, result }); res.json(result);
  });
  app.post('/api/sessions/:id/agent', (req, res) => {
    let session = findSession(req.params.id);
    const { agentId } = z.object({ agentId: requestId }).strict().parse(req.body);
    const agent = agents.get(agentId);
    const run = executions.get(session.id);
    if (run?.busy || run?.connecting || run?.dispatchPending) return res.status(409).json({ error: 'Wait for this conversation to finish before choosing another agent.' });
    if (session.agentId !== agentId) {
      if (session.threadId || session.messages.length) session = newSession(undefined, agentId);
      else {
        const runtime = run?.runtime;
        if (run) run.runtime = undefined;
        executions.delete(session.id); runtime?.close();
        session.agentId = agentId;
        session.settings = agent.kind === 'codex' ? structuredClone(runtimeState.settings) : agentSettingsSchema.parse({ model: agent.model ?? '' });
        session.status = 'idle'; session.activities = [];
      }
    }
    activeSessionId = session.id;
    defaultAgentId = agentId; store.set('defaultAgentId', agentId);
    persist(); emit({ type: 'state', state: state() }); res.json(session);
  });
  app.post('/api/sessions/:id/settings', (req, res) => {
    const session = findSession(req.params.id);
    const remember = z.enum(['true']).optional().parse(req.query.remember) === 'true';
    const settings = updateSettings(session.settings ?? runtimeState.settings, req.body, session);
    const defaults = remember ? updateSettings(runtimeState.settings, req.body, session) : undefined;
    if (remember && session.agentId !== 'codex') return res.status(400).json({ error: 'Set provider defaults in Manage agents.' });
    session.settings = settings;
    if (defaults) {
      runtimeState.settings = defaults; runtimeState.model = defaults.model;
      store.set('settings', defaults); store.set('model', defaults.model);
      runtimeChanged();
    }
    sessionChanged(session); res.json(session);
  });
  app.post('/api/sessions/:id/messages', async (req, res) => {
    const session = findSession(req.params.id); const input = messageSchema.parse(req.body);
    await executions.get(session.id)?.reviewFinishing;
    const receiptKey = `message:${session.id}:${input.requestId}`; const serializedInput = JSON.stringify(input);
    const replayReceipt = () => {
      const previous = store.get<any>(receiptKey);
      if (!previous) return false;
      if (previous.input !== serializedInput) res.status(409).json({ error: 'Request ID reused with different message content.' });
      else res.json(previous.result);
      return true;
    };
    if (replayReceipt()) return;
    const run = execution(session);
    const attachments = contextAttachments.get(input.attachments);
    const images = contextAttachments.images(attachments);
    if (images.length) {
      await connectRuntime(session);
      if (run.capabilities?.imageInput === false) return res.status(400).json({ error: 'This agent does not support image input. Choose an image-capable agent or remove the image.' });
    }
    // Image negotiation yields to other submissions; only one may accept this request ID.
    if (replayReceipt()) return;
    const runtime = run.runtime;
    const board = store.board();
    const occupied = run.busy || run.dispatchPending > 0;
    const message = { id: input.requestId, role: 'user' as const, text: input.text, ...(attachments.length ? { attachments, contextText: contextAttachments.format(attachments) } : {}), createdAt: now(), canvasReference: { boardId: board.id, revision: board.revision, elementIds: input.selection.elementIds } };
    session.messages.push(message); if (session.title === 'New session') session.title = input.text.slice(0, 60) || attachments[0]?.label || 'New session';
    const result = { ok: true, messageId: message.id, status: occupied ? 'update' : 'accepted' };
    store.set(receiptKey, { input: serializedInput, result }); sessionChanged(session);
    if (occupied) {
      if (run.busy && runtime?.activeTurnId && session.status === 'running' && run.capabilities?.steering) {
        try {
          const current = context(session, input.selection);
          await runtime.steer(`${input.text}${message.contextText ? `\n\n${message.contextText}` : ''}\n\n[Current canvas resource context]\n${JSON.stringify(current)}`, runtime.activeTurnId, images);
          session.contextRevision = current.revision;
          if (run.pendingNotice && run.pendingNotice.throughRevision <= current.revision) run.pendingNotice = undefined;
          run.noticeDeliveryBlocked = false;
        }
        catch (error: any) {
          if (error?.uncertain) { session.status = 'unknown'; systemMessage(session, 'The update outcome is uncertain. It will not be automatically resent.'); }
          else { session.queued.push({ id: input.requestId, text: input.text, selection: input.selection }); systemMessage(session, 'Update queued for the next turn.'); }
          sessionChanged(session);
        }
      } else { session.queued.push({ id: input.requestId, text: input.text, selection: input.selection }); systemMessage(session, 'Message queued for the next turn.'); sessionChanged(session); }
      drainQueued(session, run);
    } else { try { await dispatch(session, input.text, input.selection, input.requestId); } catch (error) { failTurn(session, error); } }
    res.status(202).json(result);
  });
  app.post('/api/sessions/:id/interrupt', async (req, res) => {
    const s = findSession(req.params.id);
    const run = executions.get(s.id); const runtime = run?.runtime;
    if (!s.turnId || !runtime || !run?.busy) return res.status(409).json({ error: 'There is no active turn to interrupt.' });
    s.queued = []; run.interruptedTurnId = s.turnId; sessionChanged(s);
    try { await runtime.interrupt(s.turnId); }
    catch (error) { run.interruptedTurnId = undefined; throw error; }
    res.json({ ok: true });
  });
  app.post('/api/sessions/:id/approvals/:approvalId', (req, res) => {
    const s = findSession(req.params.id); const approval = s.pendingApprovals.find(a => a.id === req.params.approvalId);
    const run = executions.get(s.id); const runtime = run?.runtime;
    if (!approval || !runtime || !run?.busy) return res.status(409).json({ error: 'This approval is no longer pending.' });
    const input = z.object({ decision: z.string(), answers: z.record(z.string(), z.any()).optional(), requestId: requestId.optional() }).parse(req.body);
    if (!approval.choices.includes(input.decision)) return res.status(400).json({ error: 'Choose an advertised decision.' });
    let answer: any = { decision: input.decision };
    if (approval.method.includes('permissions')) answer = { permissions: input.decision === 'accept' ? approval.params.permissions : {}, scope: 'turn' };
    if (approval.method.includes('requestUserInput')) answer = { answers: input.answers ?? {} };
    if (approval.method === 'mcpServer/elicitation/request') {
      if (input.decision === 'accept' && !canAcceptEmptyElicitation(approval.params)) return res.status(400).json({ error: 'This request requires a form that Canvagent cannot display yet.' });
      answer = { action: input.decision, content: input.decision === 'accept' ? {} : null, _meta: null };
    }
    if (approval.method === 'execCommandApproval' || approval.method === 'applyPatchApproval') answer = { decision: input.decision === 'accept' ? 'approved' : input.decision === 'decline' ? 'denied' : 'abort' };
    runtime.answer(approval.nativeId, answer);
    s.pendingApprovals = s.pendingApprovals.filter(a => a !== approval); s.status = s.pendingApprovals.length ? 'awaiting_approval' : 'running';
    sessionChanged(s); scheduleNotice(s, run); res.json({ ok: true });
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
    const result = store.undo(input.mutationId, input.requestId, 'human');
    if (result.ok) {
      if (store.get<string>('lastAgentMutation') === input.mutationId) store.set('lastAgentMutation', null);
      boardChanged(result, 'undo');
    }
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
  app.use('/excalidraw-assets', express.static(options.assetsDir ?? join(applicationRoot, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod'), { maxAge: '1y', immutable: true }));
  const dist = options.distDir ?? resolve('dist');
  if (existsSync(join(dist, 'index.html'))) { app.use(express.static(dist)); app.get('/{*path}', (_req, res) => res.sendFile(join(dist, 'index.html'))); }
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof z.ZodError ? 400 : error.status ?? 500;
    res.status(status).json({ error: error instanceof z.ZodError ? 'Invalid request.' : error.message ?? 'Request failed.', details: error instanceof z.ZodError ? error.issues : undefined });
  });
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!validLocalHost(req.headers.host) || !originAllowed(req.headers.origin) || !authenticated(req.headers.cookie)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    if (terminals.handleUpgrade(req, socket, head)) return;
    if (req.url !== '/api/events') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  }
  server.on('upgrade', handleUpgrade);
  wss.on('connection', socket => {
    sockets.add(socket); socket.send(JSON.stringify({ type: 'state', state: state() }));
    socket.on('error', () => socket.close()); socket.on('close', () => sockets.delete(socket));
  });
  return {
    app, server, store, tools, state, summary, handleUpgrade, notifications, markNotificationsRead,
    async close() {
      if (closed) return; closed = true;
      for (const [sessionId, run] of executions) {
        clearNotices(run);
        if (run.busy) { const session = findSession(sessionId); session.status = 'unknown'; session.pendingApprovals = []; }
        run.runtime?.close();
      }
      for (const pending of captures.values()) { clearTimeout(pending.timer); pending.reject(new Error('Application closed.')); } captures.clear();
      await Promise.allSettled([...executions.values()].flatMap(run => run.reviewFinishing ? [run.reviewFinishing] : []));
      persist(); for (const socket of sockets) socket.terminate(); wss.close();
      agents.clearKeys();
      await terminals.close();
      await new Promise<void>(resolveClose => { if (!server.listening) return resolveClose(); server.close(() => resolveClose()); server.closeAllConnections(); }); store.close();
    },
  };
  } catch (error) {
    store.close();
    throw error;
  }
}
