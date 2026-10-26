import { randomUUID } from 'node:crypto';
import type { AgentCapabilities, AgentDefinition } from '../shared/agents.js';
import type { Message } from '../shared/types.js';
import type { RuntimeImage } from '../shared/context.js';
import type { AgentRuntime, AgentRuntimeConnection } from './agent-runtime.js';
import { runtimeImageData, type RpcId, type RuntimeOptions, type ToolResult } from './runtime.js';

type Text = { type: 'text'; text: string };
type Image = { type: 'image'; url: string };
type ToolUse = { type: 'tool_use'; id: string; name: string; input: any; invalid?: boolean };
type ToolReply = { type: 'tool_result'; id: string; success: boolean; content: (Text | Image)[] };
type Block = Text | Image | ToolUse | ToolReply;
type Entry = { role: 'user' | 'assistant'; content: Block[] };
type ApiOptions = RuntimeOptions & { agent: AgentDefinition; apiKey?: string; history?: (Message & { images?: RuntimeImage[] })[] };
const maxToolRounds = 12;
const maxResponseBytes = 32 * 1024 * 1024;

/** Direct-provider canvas agent. Responses are deliberately nonstreaming in this
 * first adapter: each completed model response appears as one text delta. Native
 * tool history stays in memory; reconnects rebuild context from the saved visible
 * user/assistant transcript rather than claiming a provider-side session. */
export class ApiRuntime implements AgentRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  private connected = false;
  private connection: AgentRuntimeConnection | null = null;
  private controller: AbortController | null = null;
  private apiKey = '';
  private endpoint = '';
  private approvals = new Map<RpcId, { resolve: (accepted: boolean) => void; signal: AbortSignal; abort: () => void }>();
  private history: Entry[];
  private seeded: { id: string; index: number }[] = [];

  constructor(private readonly options: ApiOptions) {
    this.history = [];
    for (const message of options.history ?? []) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      this.seeded.push({ id: message.id, index: this.history.length });
      this.history.push({ role: message.role, content: promptContent(message.text, message.images ?? []) });
    }
  }

  async connect(): Promise<AgentRuntimeConnection> {
    if (this.connection) return this.connection;
    const { agent } = this.options;
    if (!['openai-compatible', 'anthropic'].includes(agent.kind)) throw new Error('This adapter requires an OpenAI-compatible or Anthropic API provider.');
    if (!agent.model) throw new Error('Set a model ID for this API provider.');
    let base: URL;
    try { base = new URL(agent.baseUrl ?? (agent.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')); }
    catch { throw new Error('Set a valid HTTP or HTTPS API base URL.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || !['https:', 'http:'].includes(base.protocol) || (base.protocol === 'http:' && !local)) throw new Error('Remote API endpoints require HTTPS and a URL without credentials, query, or fragment.');
    const officialBase = agent.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
    const official = base.href.replace(/\/$/, '') === officialBase;
    const keyEnvironment = agent.apiKeyEnv ?? (official ? (agent.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY') : undefined);
    this.apiKey = this.options.apiKey ?? (keyEnvironment ? process.env[keyEnvironment] : undefined) ?? '';
    if (!this.apiKey && !(local && agent.kind === 'openai-compatible')) throw new Error('Add an API key or configure the provider’s API key environment variable.');
    this.endpoint = `${base.href.replace(/\/$/, '')}/${agent.kind === 'anthropic' ? 'messages' : 'chat/completions'}`;
    const capabilities: AgentCapabilities = { steering: false, canvasChangeNotices: false, canvasTools: Boolean(this.options.tools?.length), models: true, approvalPolicy: false, reasoningEffort: false, serviceTier: false, imageInput: true };
    this.connection = { authenticated: true, models: [{ id: agent.model, name: agent.model, isDefault: true }], version: agent.kind === 'anthropic' ? 'Anthropic Messages API' : 'OpenAI-compatible Chat Completions API', defaults: { model: agent.model }, capabilities };
    this.connected = true;
    this.emit('connection.changed', { state: 'connected', ...this.connection });
    return this.connection;
  }

  async open(threadId?: string): Promise<string> {
    this.requireConnected();
    if (this.activeTurnId) throw new Error('Cannot switch API conversations while a turn is active.');
    if (this.threadId && (!threadId || threadId === this.threadId)) return this.threadId;
    if (this.threadId && threadId !== this.threadId) throw new Error('Open a new runtime to switch API conversation history.');
    this.threadId = threadId ?? `api-${randomUUID()}`;
    this.emit('thread.opened', { threadId: this.threadId, resumed: Boolean(threadId), activeTurnId: null });
    if (this.options.tools?.length) this.emit('canvas_tools.ready', { threadId: this.threadId, resumed: Boolean(threadId) });
    return this.threadId;
  }

  async start(text: string, requestId?: string, images: RuntimeImage[] = []): Promise<string> {
    this.requireConnected();
    if (!this.threadId) throw new Error('Open an API conversation first.');
    if (this.activeTurnId) throw new Error('An API turn is already active.');
    const content = promptContent(text, images);
    // The app persists user messages before constructing the adapter. Rebuild only
    // through this exact message: later queued messages must not enter context early.
    const saved = requestId ? this.seeded.find(entry => entry.id === requestId) : undefined;
    if (saved && this.history[saved.index]?.role === 'user') this.history = this.history.slice(0, saved.index);
    this.history.push({ role: 'user', content });
    this.seeded = [];
    const id = randomUUID();
    const controller = new AbortController();
    this.controller = controller;
    this.activeTurnId = id;
    this.emit('turn/started', { threadId: this.threadId, turn: { id, status: 'inProgress' } });
    void this.run(id, controller).then(() => this.finish(id, controller.signal.aborted ? 'interrupted' : 'completed'))
      .catch(error => this.finish(id, controller.signal.aborted ? 'interrupted' : 'failed', error instanceof Error ? error.message : 'The API request failed.'));
    return id;
  }

  async steer(_text: string, _turnId: string, _images?: RuntimeImage[]): Promise<void> { throw new Error('This API provider does not support steering an active turn. Your message can be queued for the next turn.'); }
  async interrupt(turnId: string): Promise<void> {
    this.requireConnected();
    if (this.activeTurnId !== turnId || !this.controller) throw new Error('The requested API turn is no longer active.');
    this.controller.abort();
  }
  answer(id: RpcId, result: any): void {
    this.requireConnected();
    const approval = this.approvals.get(id);
    if (!approval) throw new Error('This API tool approval is no longer pending.');
    if (result?.decision !== 'accept' && result?.decision !== 'decline') throw new Error('Choose an advertised API tool approval decision.');
    this.approvals.delete(id);
    approval.signal.removeEventListener('abort', approval.abort);
    approval.resolve(result.decision === 'accept');
    this.emit('approval.answered', { id });
  }
  close(): void {
    this.controller?.abort(); this.controller = null; this.activeTurnId = null;
    const wasConnected = this.connected;
    this.connected = false; this.connection = null; this.apiKey = '';
    if (wasConnected) this.emit('connection.changed', { state: 'disconnected', intentional: true, reason: 'API connection closed.' });
  }

  private async run(id: string, controller: AbortController): Promise<void> {
    const current = () => this.connected && this.activeTurnId === id && this.controller === controller && !controller.signal.aborted;
    let completeHistoryLength = this.history.length;
    try {
      for (let round = 0; round <= maxToolRounds; round++) {
        if (!current()) return;
        const response = await this.completion(controller.signal);
        if (!current()) return;
        const calls = response.content.filter((block): block is ToolUse => block.type === 'tool_use');
        if (calls.length > 32 || new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('The provider returned an invalid batch of tool calls.');
        this.history.push(response);
        const text = response.content.filter((block): block is Text => block.type === 'text').map(block => block.text).join('\n');
        if (text) this.emit('item/agentMessage/delta', { threadId: this.threadId, turnId: id, itemId: `api:${id}:${round}`, delta: text });
        if (!calls.length) { completeHistoryLength = this.history.length; return; }
        if (round === maxToolRounds) throw new Error('The agent reached the canvas tool round limit. Send another message to continue.');
        const replies: ToolReply[] = [];
        for (const call of calls) {
          if (!current()) return;
          const item = { id: `api-tool:${id}:${call.id}`, type: call.name.startsWith('workspace_') ? 'workspaceTool' : 'canvasTool', name: call.name, status: 'running' };
          this.emit('item/started', { threadId: this.threadId, turnId: id, item });
          let result: ToolResult;
          if (call.invalid || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) result = { success: false, contentItems: [{ type: 'inputText', text: 'Tool arguments must be a valid JSON object.' }] };
          else if (!(this.options.tools ?? []).some(tool => tool.name === call.name)) result = { success: false, contentItems: [{ type: 'inputText', text: 'This tool is not available.' }] };
          else {
            const protectedTool = ['workspace_write', 'workspace_create', 'workspace_command'].includes(call.name);
            const accepted = !protectedTool || await this.approveWorkspaceTool(call, id, item.id, controller.signal);
            if (!current()) return;
            try { result = accepted ? await this.options.onTool(call.name, call.input, controller.signal) : { success: false, contentItems: [{ type: 'inputText', text: 'The user declined this workspace operation. Do not retry it without a new instruction.' }] }; }
            catch { result = { success: false, contentItems: [{ type: 'inputText', text: 'The tool failed. Inspect the current resource state before retrying.' }] }; }
          }
          if (!current()) return;
          replies.push({ type: 'tool_result', id: call.id, success: result.success, content: toolContent(result) });
          this.emit('item/completed', { threadId: this.threadId, turnId: id, item: { ...item, status: result.success ? 'completed' : 'failed' } });
        }
        this.history.push({ role: 'user', content: replies });
        completeHistoryLength = this.history.length;
      }
    } finally {
      // A cancelled/failed turn can leave an assistant tool_use without all results.
      // Never send that invalid sequence on the next request. Retain its visible text.
      this.history = this.history.map((entry, index) => index < completeHistoryLength ? entry : { role: entry.role, content: entry.content.filter(block => block.type === 'text' || block.type === 'image') }).filter(entry => entry.content.length > 0);
    }
  }

  private async completion(signal: AbortSignal): Promise<Entry> {
    const anthropic = this.options.agent.kind === 'anthropic';
    const model = this.options.settings?.().model || this.options.model || this.options.agent.model;
    const instructions = [this.options.developerInstructions, this.options.settings?.().additionalInstructions].filter(Boolean).join('\n\n');
    const tools = this.options.tools ?? [];
    const body = anthropic ? {
      model, max_tokens: 8192, stream: false, ...(instructions ? { system: instructions } : {}),
      messages: this.history.map(entry => ({ role: entry.role, content: entry.content.map(anthropicBlock) })),
      ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
    } : {
      model, stream: false, messages: [...(instructions ? [{ role: 'system', content: instructions }] : []), ...openaiMessages(this.history)],
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
    };
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000)]),
        headers: { 'Content-Type': 'application/json', ...(anthropic ? { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' } : this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch { throw new Error(signal.aborted ? 'API turn interrupted.' : 'The API request could not be completed. Check the endpoint, network, and provider configuration.'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        const message = 'The API provider rejected authentication. Check its API key and access.';
        if (this.connection) this.connection.authenticated = false;
        this.emit('runtime.error', { message, authenticationRequired: true });
        throw new Error(message);
      }
      throw new Error(`The API provider returned HTTP ${response.status}. Check the model and provider configuration.`);
    }
    let value: any;
    try { value = JSON.parse(await boundedText(response)); }
    catch { throw new Error('The API provider returned an invalid or oversized JSON response.'); }
    if (signal.aborted) throw new Error('API turn interrupted.');
    return anthropic ? parseAnthropic(value) : parseOpenai(value);
  }

  private approveWorkspaceTool(call: ToolUse, turnId: string, itemId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const id = `api-approval:${randomUUID()}`;
    const command = call.name === 'workspace_command';
    const path = typeof call.input.path === 'string' ? call.input.path : '';
    const content = typeof call.input.content === 'string' ? call.input.content : '';
    const preview = content.slice(0, 4_000);
    return new Promise(resolve => {
      const abort = () => {
        this.approvals.delete(id);
        this.emit('serverRequest/resolved', { requestId: id });
        resolve(false);
      };
      this.approvals.set(id, { resolve, signal, abort });
      signal.addEventListener('abort', abort, { once: true });
      const params = {
        threadId: this.threadId, turnId, itemId, cwd: this.options.cwd,
        availableDecisions: ['accept', 'decline'],
        reason: command ? 'Allow the agent to run this executable in your project?'
          : `Allow the agent to ${call.name === 'workspace_create' ? 'create' : 'replace'} ${path}?\n\nContent preview:\n${preview}${content.length > preview.length ? '\n[Preview truncated]' : ''}`,
        ...(command ? { command: JSON.stringify({ executable: call.input.executable, args: call.input.args ?? [] }) }
          : { path, contentPreview: preview, previewTruncated: content.length > preview.length, revision: call.input.revision }),
      };
      try { this.options.onApproval({ id, method: command ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval', params }); }
      catch { signal.removeEventListener('abort', abort); this.approvals.delete(id); resolve(false); }
    });
  }

  private finish(id: string, status: string, message?: string): void {
    if (this.activeTurnId !== id) return;
    this.activeTurnId = null; this.controller = null;
    this.emit('turn/completed', { threadId: this.threadId, turn: { id, status, ...(message && status === 'failed' ? { error: { message } } : {}) } });
  }
  private requireConnected(): void { if (!this.connected) throw new Error('Connect the API provider first.'); }
  private emit(type: string, payload: any): void { this.options.onEvent({ type, payload }); }
}

function promptContent(text: string, images: RuntimeImage[]): (Text | Image)[] {
  for (const image of images) runtimeImageData(image);
  return [...(text || !images.length ? [{ type: 'text' as const, text }] : []),
    ...images.map(image => ({ type: 'image' as const, url: image.url }))];
}

function toolContent(result: ToolResult): (Text | Image)[] {
  const content: (Text | Image)[] = [];
  for (const item of result.contentItems ?? []) {
    if (item?.type === 'inputText' && typeof item.text === 'string') content.push({ type: 'text', text: item.text });
    else if (item?.type === 'inputImage' && typeof item.imageUrl === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(item.imageUrl)) content.push({ type: 'image', url: item.imageUrl });
  }
  if (!content.length) content.push({ type: 'text', text: result.success ? 'Canvas tool completed.' : 'Canvas tool failed.' });
  return content;
}

function anthropicBlock(block: Block): any {
  if (block.type === 'text') return block;
  if (block.type === 'image') {
    const [, media_type, data] = block.url.match(/^data:([^;]+);base64,(.*)$/)!;
    return { type: 'image', source: { type: 'base64', media_type, data } };
  }
  if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  return { type: 'tool_result', tool_use_id: block.id, is_error: !block.success, content: block.content.map(anthropicBlock) };
}

function openaiMessages(entries: Entry[]): any[] {
  const messages: any[] = [];
  const imageContent = (block: Text | Image) => block.type === 'text' ? block : { type: 'image_url', image_url: { url: block.url } };
  for (const entry of entries) {
    const replies = entry.content.filter((block): block is ToolReply => block.type === 'tool_result');
    if (replies.length) {
      // Chat Completions tool messages accept text, so deliver images in a user
      // message after *all* matching tool responses, preserving call/result order.
      for (const reply of replies) messages.push({ role: 'tool', tool_call_id: reply.id, content: reply.content.filter((block): block is Text => block.type === 'text').map(block => block.text).join('\n') || (reply.success ? 'Canvas image follows.' : 'Canvas tool failed.') });
      const images = replies.flatMap(reply => reply.content.filter((block): block is Image => block.type === 'image'));
      if (images.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Canvas images returned by the preceding tools.' }, ...images.map(imageContent)] });
      continue;
    }
    const calls = entry.content.filter((block): block is ToolUse => block.type === 'tool_use');
    const content = entry.content.filter((block): block is Text | Image => block.type === 'text' || block.type === 'image');
    messages.push({ role: entry.role, content: content.length ? content.map(imageContent) : null,
      ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}) });
  }
  return messages;
}

function parseOpenai(value: any): Entry {
  const choice = value?.choices?.[0];
  const message = choice?.message;
  if (!message || (message.role && message.role !== 'assistant')) throw new Error('The API provider returned no assistant response.');
  if (choice.finish_reason === 'length') throw new Error('The API provider reached its response token limit.');
  const content: Block[] = [];
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  else if (Array.isArray(message.content)) for (const block of message.content) if (block?.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text });
  if (typeof message.refusal === 'string' && message.refusal) content.push({ type: 'text', text: message.refusal });
  for (const call of message.tool_calls ?? []) {
    if (typeof call?.id !== 'string' || !call.id || typeof call.function?.name !== 'string') throw new Error('The API provider returned an invalid tool call.');
    let input: any = {}; let invalid = false;
    try { input = JSON.parse(call.function.arguments); } catch { invalid = true; }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input, invalid });
  }
  if (!content.length) throw new Error('The API provider returned an empty assistant response.');
  return { role: 'assistant', content };
}

function parseAnthropic(value: any): Entry {
  if (!Array.isArray(value?.content)) throw new Error('The API provider returned no assistant response.');
  if (value.stop_reason === 'max_tokens') throw new Error('The API provider reached its response token limit.');
  const content: Block[] = [];
  for (const block of value.content) {
    if (block?.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text });
    else if (block?.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string') throw new Error('The API provider returned an invalid tool call.');
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
  }
  if (!content.length) throw new Error('The API provider returned an empty assistant response.');
  return { role: 'assistant', content };
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error('Missing API response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxResponseBytes) throw new Error('Oversized API response.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks).toString('utf8');
}
