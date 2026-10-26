import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import type { AgentCapabilities, AgentDefinition } from '../shared/agents.js';
import type { RuntimeImage } from '../shared/context.js';
import type { AgentRuntime } from './agent-runtime.js';
import { RuntimeRequestError, runtimeImageData, type ApprovalRequest, type RpcId, type RuntimeConnection, type RuntimeOptions } from './runtime.js';
import { canvasServerName } from './canvas-mcp.js';
import { canvasMcpBridgeSource } from './mcp-bridge.js';

type Pending = { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Connection = RuntimeConnection & { capabilities: AgentCapabilities };

/** ACP v1 JSON-RPC over stdio. Filesystem and terminal delegation are deliberately
 * unadvertised: a local agent can use its own tools, but cannot bypass client policy. */
export class AcpRuntime implements AgentRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private permissions = new Map<RpcId, ApprovalRequest>();
  private toolItems = new Map<string, any>();
  private connecting: Promise<Connection> | null = null;
  private connection: Connection | null = null;
  private agentCapabilities: any = {};
  private opening = false;
  private cancelling = false;
  private intentional = false;

  constructor(private readonly options: RuntimeOptions & { agent: AgentDefinition }) {}

  connect(): Promise<Connection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.connecting) return this.connecting;
    const { agent } = this.options;
    if (!agent.command) return Promise.reject(new Error('An ACP executable is required.'));
    const env = { ...process.env };
    for (const [target, source] of Object.entries(agent.env ?? {})) {
      if (process.env[source] === undefined) return Promise.reject(new Error(`Required environment variable ${source} is not set.`));
      env[target] = process.env[source];
    }
    this.intentional = false;
    this.emit('connection.changed', { state: 'connecting' });
    const child = spawn(agent.command, agent.args ?? [], { cwd: this.options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      if (this.child !== child) return;
      try { this.receive(JSON.parse(line)); }
      catch { this.emit('runtime.error', { message: 'Invalid ACP protocol message.' }); }
    });
    // Agent diagnostics can contain credentials. Keep stdout protocol-only and drain stderr.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.disconnected(child, 'ACP input pipe closed.'));
    child.on('error', () => this.disconnected(child, 'Could not run the ACP executable. Check its installation and command.'));
    child.on('exit', (code, signal) => this.disconnected(child, `ACP agent exited (${signal ?? code ?? 'unknown'}).`));
    this.connecting = (async () => {
      try {
        const result = await this.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'canvagent', title: 'Canvagent', version: '0.1.0' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        });
        if (result?.protocolVersion !== 1) throw new Error('This agent did not negotiate supported ACP protocol version 1.');
        if (this.child !== child) throw new Error('ACP agent disconnected during initialization.');
        this.agentCapabilities = result.agentCapabilities ?? {};
        // Authentication is owned by the harness; ACP has no generic read-account method.
        // An auth-required error from session/new is surfaced without initiating a login.
        const connection: Connection = {
          authenticated: true, models: [], version: result.agentInfo?.version ?? 'ACP v1',
          capabilities: { steering: false, canvasChangeNotices: false,
            imageInput: this.agentCapabilities.promptCapabilities?.image === true,
            canvasTools: Boolean(this.options.canvasMcp),
            models: false, approvalPolicy: false, reasoningEffort: false, serviceTier: false },
        };
        this.connection = connection;
        this.emit('connection.changed', { state: 'connected', ...connection });
        return connection;
      } catch (error) { if (this.child === child) this.close(); throw error; }
    })();
    return this.connecting;
  }

  async open(threadId?: string): Promise<string> {
    this.requireConnected();
    if (this.opening || this.activeTurnId) throw new Error('Cannot switch ACP sessions while a turn or session operation is active.');
    if (threadId && threadId === this.threadId) return threadId;
    if (threadId && this.agentCapabilities.loadSession !== true) throw new Error('This ACP agent cannot resume saved sessions. Create a new conversation to continue.');
    this.opening = true;
    try {
      const mcpServers = !this.options.canvasMcp ? [] : this.agentCapabilities.mcpCapabilities?.http ? [{
        type: 'http', name: canvasServerName, url: this.options.canvasMcp!.url(),
        headers: [{ name: 'Authorization', value: `Bearer ${this.options.canvasMcp!.token}` }],
      }] : [{ name: canvasServerName, command: process.execPath, args: ['-e', canvasMcpBridgeSource], env: [
        { name: 'CANVAGENT_CANVAS_MCP_URL', value: this.options.canvasMcp.url() },
        { name: 'CANVAGENT_CANVAS_MCP_TOKEN', value: this.options.canvasMcp.token },
      ] }];
      const result = await this.request(threadId ? 'session/load' : 'session/new', {
        cwd: this.options.cwd, mcpServers, ...(threadId ? { sessionId: threadId } : {}),
      });
      const id = threadId ?? result?.sessionId;
      if (typeof id !== 'string' || !id) throw new Error('ACP agent returned a session without an ID.');
      if (threadId && result?.sessionId && result.sessionId !== threadId) throw new Error('ACP agent returned a different saved session.');
      this.threadId = id;
      this.toolItems.clear();
      this.emit('thread.opened', { threadId: id, resumed: Boolean(threadId), activeTurnId: null });
      if (mcpServers.length) this.emit('canvas_tools.ready', { threadId: id, resumed: Boolean(threadId) });
      return id;
    } finally { this.opening = false; }
  }

  async start(text: string, _requestId?: string, images: RuntimeImage[] = []): Promise<string> {
    this.requireConnected();
    if (!this.threadId) throw new Error('Open an ACP session first.');
    if (this.opening || this.activeTurnId) throw new Error('An ACP turn is already active.');
    if (images.length && this.agentCapabilities.promptCapabilities?.image !== true) throw new Error('This ACP agent does not support image attachments. Remove the images or choose an agent with image input support.');
    const imageBlocks = images.map(image => ({ type: 'image', data: runtimeImageData(image), mimeType: image.mimeType }));
    const child = this.child;
    const id = randomUUID();
    this.activeTurnId = id;
    this.cancelling = false;
    this.toolItems.clear();
    this.emit('turn/started', { threadId: this.threadId, turn: { id, status: 'inProgress' } });
    const instructions = [this.options.developerInstructions, this.options.settings?.().additionalInstructions].filter(Boolean).join('\n\n');
    const prompt = [...(instructions ? [{ type: 'text', text: `[Canvagent instructions]\n${instructions}` }] : []),
      ...(text || !images.length ? [{ type: 'text', text }] : []), ...imageBlocks];
    // ACP holds session/prompt open until all model/tool activity finishes. Return our
    // stable turn identity immediately so the UI can cancel and answer permissions.
    void this.request('session/prompt', { sessionId: this.threadId, prompt }, this.options.requestTimeoutMs ?? 30 * 60_000)
      .then(result => {
        if (this.child !== child || this.activeTurnId !== id) return;
        const stop = result?.stopReason;
        if (stop === 'cancelled') this.finish(id, 'interrupted');
        else if (stop === 'end_turn' || stop === 'refusal') this.finish(id, 'completed');
        else this.finish(id, 'failed', stop === 'max_tokens' ? 'The ACP agent reached its token limit.' : stop === 'max_turn_requests' ? 'The ACP agent reached its request limit.' : 'ACP agent returned an unsupported stop reason.');
      }).catch(error => {
        if (this.child !== child || this.activeTurnId !== id) return;
        if (error instanceof RuntimeRequestError && error.uncertain) { this.closeUncertain('ACP turn outcome is unknown; reconnect before continuing.'); return; }
        this.finish(id, this.cancelling && error instanceof RuntimeRequestError && error.code === -32800 ? 'interrupted' : 'failed', error.message);
      });
    return id;
  }

  async steer(_text: string, _turnId: string, _images?: RuntimeImage[]): Promise<void> { throw new Error('ACP v1 does not support steering an active turn. Your message can be queued for the next turn.'); }

  async interrupt(turnId: string): Promise<void> {
    this.requireConnected();
    if (this.activeTurnId !== turnId) throw new Error('The requested ACP turn is no longer active.');
    this.cancelling = true;
    this.cancelPermissions();
    this.write({ method: 'session/cancel', params: { sessionId: this.threadId } });
    for (const item of this.toolItems.values()) {
      if (!['completed', 'failed', 'cancelled'].includes(item.status)) this.emit('item/completed', { threadId: this.threadId, turnId, item: { ...item, status: 'cancelled' } });
    }
    // The prompt response confirms cancellation; retain activeTurnId until then.
  }

  answer(id: RpcId, result: any): void {
    this.requireConnected();
    const request = this.permissions.get(id);
    if (!request) throw new Error('This ACP permission is no longer pending.');
    const decision = result?.decision;
    if (!request.params.options.some((option: any) => option.optionId === decision)) throw new Error('Choose an advertised ACP permission option.');
    this.write({ id, result: { outcome: { outcome: 'selected', optionId: decision } } });
    this.permissions.delete(id);
    this.emit('approval.answered', { id });
  }

  close(): void {
    this.intentional = true;
    if (this.child) { this.cancelPermissions(); this.stopChild(this.child, 'ACP connection closed.'); }
    else this.connecting = null;
  }

  private closeUncertain(reason: string): void { this.intentional = false; if (this.child) this.stopChild(this.child, reason); }
  private stopChild(child: ChildProcessWithoutNullStreams, reason: string): void {
    this.disconnected(child, reason);
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2_000);
    timer.unref();
  }
  private requireConnected(): void { if (!this.child || !this.connection) throw new Error('Connect the ACP agent first.'); }
  private emit(type: string, payload: any): void { this.options.onEvent({ type, payload }); }
  private finish(id: string, status: string, message?: string): void {
    this.cancelPermissions();
    this.activeTurnId = null;
    this.emit('turn/completed', { threadId: this.threadId, turn: { id, status, ...(message ? { error: { message } } : {}) } });
  }
  private cancelPermissions(): void {
    for (const id of this.permissions.keys()) {
      try { this.write({ id, result: { outcome: { outcome: 'cancelled' } } }); } catch { /* disconnect already rejects work */ }
      this.emit('serverRequest/resolved', { requestId: id });
    }
    this.permissions.clear();
  }
  private write(message: any): void {
    if (!this.child?.stdin.writable || this.child.stdin.destroyed) throw new Error('ACP agent is disconnected.');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }
  private request(method: string, params: any, timeout = this.options.requestTimeoutMs ?? 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RuntimeRequestError(`ACP request timed out: ${method}`, method, true)); }, timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new RuntimeRequestError('ACP agent is disconnected.', method, true)); }
    });
  }
  private receive(frame: any): void {
    if (!frame || typeof frame !== 'object' || frame.jsonrpc !== '2.0') throw new Error('Invalid ACP frame.');
    if (typeof frame.method === 'string') {
      if (typeof frame.id === 'string' || typeof frame.id === 'number') {
        const p = frame.params;
        if (frame.method === 'session/request_permission' && p?.sessionId === this.threadId && this.activeTurnId && !this.cancelling && Array.isArray(p.options) && p.options.length && p.options.every((option: any) => typeof option?.optionId === 'string' && typeof option?.name === 'string')) {
          if (this.permissions.has(frame.id)) return;
          const request = { id: frame.id, method: 'acp/request_permission', params: { ...p, availableDecisions: p.options.map((option: any) => option.optionId) } };
          this.permissions.set(frame.id, request);
          try { this.options.onApproval(request); }
          catch { this.permissions.delete(frame.id); this.write({ id: frame.id, result: { outcome: { outcome: 'cancelled' } } }); }
        } else if (frame.method === 'session/request_permission') this.write({ id: frame.id, result: { outcome: { outcome: 'cancelled' } } });
        else this.write({ id: frame.id, error: { code: -32601, message: 'This client capability is not supported.' } });
      } else if (frame.method === 'session/update') this.update(frame.params);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id); clearTimeout(pending.timer);
    // Never expose arbitrary error text from a subprocess: adapters sometimes echo
    // their full config, which includes env credentials and the MCP bearer header.
    if (frame.error) {
      // -32000 is ACP's structured authentication-required code. Do not inspect
      // arbitrary message/data text, which can reflect secrets from the harness.
      if (frame.error.code === -32000) {
        if (this.connection) this.connection.authenticated = false;
        this.emit('runtime.error', { message: 'ACP authentication is required. Check the harness login and configuration.', authenticationRequired: true });
      }
      pending.reject(new RuntimeRequestError(frame.error.code === -32000 || frame.error.code === -32001 ? 'ACP request failed. Check the harness login and configuration.' : `ACP request failed: ${pending.method} (code ${Number(frame.error.code) || 'unknown'}).`, pending.method, false, frame.error.code));
    } else pending.resolve(frame.result);
  }
  private update(params: any): void {
    if (this.opening || params?.sessionId !== this.threadId || !this.activeTurnId) return; // Ignore saved-history replay; Canvagent already has its visible transcript.
    const update = params.update;
    if (!update || typeof update !== 'object') return;
    const common = { threadId: this.threadId, turnId: this.activeTurnId };
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
      this.emit('item/agentMessage/delta', { ...common, itemId: `acp:${this.activeTurnId}:${update.messageId ?? 'message'}`, delta: update.content.text });
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate) && typeof update.toolCallId === 'string') {
      const previous = this.toolItems.get(update.toolCallId) ?? { id: update.toolCallId, type: 'acpToolCall', name: 'Agent tool', status: 'pending' };
      const item = { ...previous, ...(update.title ? { name: update.title } : {}), ...(update.status ? { status: update.status } : {}),
        ...(Array.isArray(update.content) ? { output: update.content.filter((entry: any) => entry?.type === 'content' && entry.content?.type === 'text').map((entry: any) => entry.content.text).join('\n') } : {}) };
      this.toolItems.set(update.toolCallId, item);
      this.emit(['completed', 'failed'].includes(item.status) ? 'item/completed' : 'item/started', { ...common, item });
    } else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
      for (const [index, entry] of update.entries.entries()) {
        if (typeof entry?.content !== 'string') continue;
        this.emit(entry.status === 'completed' ? 'item/completed' : 'item/started', { ...common, item: { id: `acp-plan:${this.activeTurnId}:${index}`, type: 'plan', name: entry.content, status: entry.status } });
      }
    }
  }
  private disconnected(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child) return;
    this.child = null; this.connection = null; this.connecting = null;
    this.lines?.close(); this.lines = null; this.permissions.clear(); this.toolItems.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RuntimeRequestError(reason, pending.method, true)); }
    this.pending.clear(); this.activeTurnId = null; this.threadId = null;
    this.emit('connection.changed', { state: 'disconnected', reason, intentional: this.intentional });
  }
}
