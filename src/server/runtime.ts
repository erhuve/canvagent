import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { canvasServerName, canvasTokenEnvironment } from './canvas-mcp.js';
import { defaultAgentSettings, serviceTierForModel, settingsCompatibilityError, type AgentModel, type AgentSettings, type SettingsRequirements } from '../shared/settings.js';
import type { AgentCapabilities } from '../shared/agents.js';
import type { RuntimeImage } from '../shared/context.js';

export type RpcId = string | number;
export type RuntimeEvent = { type: string; payload: any };
export type ToolResult = { contentItems: any[]; success: boolean };
export type CanvasTool = { name: string; description: string; inputSchema: any };
export type ApprovalRequest = { id: RpcId; method: string; params: any };
export type RuntimeConnection = {
  authenticated: boolean;
  models: AgentModel[];
  version: string;
  defaults?: Partial<AgentSettings>;
  requirements?: SettingsRequirements;
  capabilities?: AgentCapabilities;
};

export interface RuntimeOptions {
  cwd: string;
  model?: string;
  /** Read once when opening a thread so edits during a run affect its next turn. */
  settings?: () => AgentSettings;
  tools?: CanvasTool[];
  developerInstructions?: string;
  /** Per-conversation local MCP endpoint. Unlike persisted dynamic tools, this
   * connection can discover the current catalogue when a thread is resumed. */
  canvasMcp?: { url: () => string; token: string };
  onEvent: (event: RuntimeEvent) => void;
  onTool: (name: string, args: any, signal?: AbortSignal) => Promise<ToolResult>;
  onApproval: (request: ApprovalRequest) => void;
  /** Subprocess injection is useful for installations and protocol tests. No shell is used. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

export class RuntimeRequestError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly uncertain: boolean,
    readonly code?: number,
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

type PendingRequest = {
  method: string;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const interactiveMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "execCommandApproval",
  "applyPatchApproval",
]);

/** Codex app-server newline-delimited JSON-RPC over local stdio. */
export class CodexRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private incoming = new Map<RpcId, ApprovalRequest>();
  private terminalTurns = new Set<string>();
  private connecting: Promise<RuntimeConnection> | null = null;
  private connection: RuntimeConnection | null = null;
  private openedSettings: AgentSettings | null = null;
  private effectiveModel: string | null = null;
  private effectiveEffort: string | null = null;
  private effectiveSandbox: any = null;
  private connected = false;
  private starting = false;
  private opening = false;
  private uncertainSubmission = false;
  private intentionalClose = false;
  private generation = 0;
  private canvasToolsReady = false;

  constructor(private readonly options: RuntimeOptions) {}

  connect(): Promise<RuntimeConnection> {
    if (this.connecting) return this.connecting;
    this.intentionalClose = false;
    const generation = ++this.generation;
    this.emit("connection.changed", { state: "connecting" });
    const child = spawn(this.options.command ?? "codex", this.options.args ?? ["app-server"], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit the runtime's configured authentication; never read credential files here.
      env: { ...process.env, ...this.options.env, ...(this.options.canvasMcp ? { [canvasTokenEnvironment]: this.options.canvasMcp.token } : {}) },
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      if (this.child !== child) return;
      try {
        this.receive(JSON.parse(line));
      } catch (error) {
        // Do not log a raw frame: it could contain account or tool information.
        this.emit("runtime.error", { message: error instanceof SyntaxError ? "Invalid JSON from Codex app-server" : errorMessage(error) });
      }
    });
    // Drain diagnostics, but do not forward raw stderr (it may include account details).
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.disconnected(child, "Codex input pipe closed"));
    child.on("error", (error) => this.disconnected(child, `Could not run Codex: ${error.message}`));
    child.on("exit", (code, signal) => this.disconnected(child, `Codex exited (${signal ?? code ?? "unknown"})`));

    this.connecting = (async () => {
      try {
        const initialized = await this.request("initialize", {
          clientInfo: { name: "canvagent", title: "Canvagent", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        this.write({ method: "initialized", params: {} });
        const [account, firstPage, version, config, requirements] = await Promise.all([
          this.request("account/read", { refreshToken: false }),
          this.request("model/list", { limit: 100 }),
          this.readVersion(initialized.userAgent),
          this.optionalRequest('config/read', { cwd: this.options.cwd, includeLayers: false }),
          this.optionalRequest('configRequirements/read', {}),
        ]);
        const modelRows = [...(firstPage.data ?? [])];
        let cursor = firstPage.nextCursor;
        const seenCursors = new Set<string>();
        while (cursor && !seenCursors.has(cursor)) {
          seenCursors.add(cursor);
          const page = await this.request("model/list", { limit: 100, cursor });
          modelRows.push(...(page.data ?? []));
          cursor = page.nextCursor;
        }
        if (this.child !== child) throw new Error("Codex disconnected during initialization");
        this.connected = true;
        const result: RuntimeConnection = {
          authenticated: Boolean(account.account) || account.requiresOpenaiAuth === false,
          models: modelRows.map(modelMetadata),
          version,
          capabilities: { steering: true, canvasChangeNotices: false, canvasTools: true, models: true, approvalPolicy: true, reasoningEffort: true, serviceTier: true, imageInput: true },
          ...(config ? { defaults: settingsDefaults(config.config) } : {}),
          ...(requirements?.requirements ? { requirements: settingsRequirements(requirements.requirements) } : {}),
        };
        this.connection = result;
        this.emit("connection.changed", { state: "connected", ...result });
        return result;
      } catch (error) {
        if (generation === this.generation) this.close();
        throw error;
      }
    })();
    return this.connecting;
  }

  async open(threadId?: string): Promise<string> {
    this.requireConnected();
    if (this.opening || this.starting || this.activeTurnId) throw new Error("Cannot switch threads while a turn or session operation is active");
    this.opening = true;
    this.canvasToolsReady = false;
    try {
      const requestedSettings = structuredClone(this.options.settings?.() ?? { ...defaultAgentSettings(), model: this.options.model ?? '' });
      const settings = inheritedSettings(requestedSettings, this.connection);
      const compatibilityError = settingsCompatibilityError(settings, this.connection?.models ?? [], this.connection?.requirements);
      if (compatibilityError) throw new Error(compatibilityError);
      const config = threadConfig(settings, this.options.canvasMcp);
      const developerInstructions = [this.options.developerInstructions, settings.additionalInstructions].filter(Boolean).join('\n\n');
      // Preserve the canvas instructions when an advanced config includes its own value.
      if (developerInstructions) {
        setConfigPath(config, 'developer_instructions', developerInstructions);
        delete config.developer_instructions;
      }
      const common = {
        cwd: this.options.cwd,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
        ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
        ...(settings.approvalsReviewer ? { approvalsReviewer: settings.approvalsReviewer } : {}),
        ...(settings.sandboxMode ? { sandbox: settings.sandboxMode } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(Object.keys(config).length ? { config } : {}),
      };
      const response = threadId
        ? await this.request("thread/resume", { ...common, threadId })
        : await this.request("thread/start", {
            ...common,
            // Experimental in 0.159.2; these are native dynamic tools, not MCP names.
            ...(!this.options.canvasMcp ? { dynamicTools: (this.options.tools ?? []).map((tool) => ({ type: "function", ...tool })) } : {}),
          });
      if (typeof response.thread?.id !== "string") throw new Error("Codex returned a thread without an ID");
      if (threadId && response.thread.id !== threadId) throw new Error('Codex returned a different conversation while resuming; the saved binding was retained.');
      this.threadId = response.thread.id;
      this.openedSettings = settings;
      this.effectiveModel = settings.model || response.model || null;
      if (!this.effectiveModel) this.effectiveModel = this.connection?.defaults?.model || this.connection?.models.find(model => model.isDefault)?.id || this.connection?.models[0]?.id || null;
      this.effectiveEffort = settings.reasoningEffort || response.reasoningEffort || this.connection?.defaults?.reasoningEffort || null;
      this.effectiveSandbox = response.sandbox ?? null;
      this.activeTurnId = response.thread.turns?.find((turn: any) => turn.status === "inProgress")?.id ?? null;
      if (this.options.canvasMcp) {
        const inventory = await this.request('mcpServerStatus/list', { threadId: this.threadId, serverName: canvasServerName });
        const server = inventory.data?.find((entry: any) => entry.name === canvasServerName);
        if (!server || server.toolsError || (this.options.tools ?? []).some(tool => !server.tools?.[tool.name])) throw new Error('The current canvas tools could not be loaded. Your conversation is retained; reconnect and try again.');
        this.canvasToolsReady = true;
        this.emit('canvas_tools.ready', { threadId: this.threadId, resumed: Boolean(threadId) });
      }
      this.uncertainSubmission = false;
      this.emit("thread.opened", { threadId: this.threadId, resumed: Boolean(threadId), activeTurnId: this.activeTurnId });
      return this.threadId!;
    } finally {
      this.opening = false;
    }
  }

  async start(text: string, requestId?: string, images: RuntimeImage[] = []): Promise<string> {
    this.requireThread();
    if (this.options.canvasMcp && !this.canvasToolsReady) throw new Error('Load the current canvas tools before starting another turn.');
    if (this.opening || this.starting || this.activeTurnId) throw new Error("A Codex turn is already active");
    if (this.uncertainSubmission) throw new Error("The previous submission outcome is unknown; resume the existing thread before sending again");
    const input = promptInput(text, images);
    this.starting = true;
    try {
      const response = await this.request("turn/start", {
        threadId: this.threadId,
        input,
        ...(requestId ? { clientUserMessageId: requestId } : {}),
        ...turnSettings(this.openedSettings, this.effectiveModel, this.effectiveEffort, this.effectiveSandbox, this.connection?.defaults),
      });
      if (typeof response.turn?.id !== "string") {
        this.uncertainSubmission = true;
        throw new Error("Codex accepted a turn without returning its ID; reconcile before retrying");
      }
      const turnId = response.turn.id;
      if (!this.terminalTurns.has(turnId) && response.turn.status === "inProgress") this.activeTurnId = turnId;
      return turnId;
    } catch (error) {
      if (error instanceof RuntimeRequestError && error.uncertain) this.uncertainSubmission = true;
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async steer(text: string, expectedTurnId: string, images: RuntimeImage[] = []): Promise<void> {
    this.requireThread();
    if (this.activeTurnId !== expectedTurnId) throw new Error("The requested Codex turn is no longer active");
    await this.request("turn/steer", { threadId: this.threadId, expectedTurnId, input: promptInput(text, images) });
  }

  async interrupt(turnId: string): Promise<void> {
    this.requireThread();
    if (this.activeTurnId !== turnId) throw new Error("The requested Codex turn is no longer active");
    await this.request("turn/interrupt", { threadId: this.threadId, turnId });
    // Keep the active identity until turn/completed confirms interruption.
  }

  answer(id: RpcId, result: any): void {
    this.requireConnected();
    if (!this.incoming.has(id)) throw new Error("This Codex request is no longer pending on the current connection");
    this.write({ id, result });
    this.incoming.delete(id);
    this.emit("approval.answered", { id });
  }

  close(): void {
    this.intentionalClose = true;
    const child = this.child;
    if (!child) {
      this.connecting = null;
      return;
    }
    this.disconnected(child, "Codex connection closed");
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2_000);
    killTimer.unref();
  }

  private request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeRequestError(`Codex request timed out: ${method}`, method, true));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RuntimeRequestError(errorMessage(error), method, true));
      }
    });
  }

  private async optionalRequest(method: string, params: any): Promise<any | undefined> {
    try {
      return await this.request(method, params);
    } catch (error) {
      // Older app servers lack these metadata methods. Other failures can carry
      // managed-policy or configuration errors and must remain visible.
      if (error instanceof RuntimeRequestError && error.code === -32601) return undefined;
      throw error;
    }
  }

  private write(message: any): void {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error("Codex is disconnected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: any): void {
    if (!message || typeof message !== "object") throw new Error("Invalid Codex protocol frame");
    if (typeof message.method === "string") {
      if (typeof message.id === "string" || typeof message.id === "number") {
        void this.handleServerRequest(message);
        return;
      }
      const params = message.params ?? {};
      if (message.method === "turn/started" && params.threadId === this.threadId) {
        this.activeTurnId = params.turn.id;
      } else if (message.method === "turn/completed" && params.threadId === this.threadId) {
        this.terminalTurns.add(params.turn.id);
        if (this.terminalTurns.size > 100) this.terminalTurns.delete(this.terminalTurns.values().next().value!);
        if (this.activeTurnId === params.turn.id) this.activeTurnId = null;
      } else if (message.method === "serverRequest/resolved") {
        this.incoming.delete(params.requestId);
      }
      this.emit(message.method, params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // A timed-out reply must not execute or resend anything.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new RuntimeRequestError(String(message.error.message ?? "Codex request failed"), pending.method, false, message.error.code));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleServerRequest(request: ApprovalRequest): Promise<void> {
    const child = this.child;
    if (this.incoming.has(request.id)) return;
    this.incoming.set(request.id, request);
    try {
      if (request.method === "item/tool/call") {
        const params = request.params;
        if (params.threadId !== this.threadId || params.turnId !== this.activeTurnId) throw new Error("Canvas tool call does not belong to the active turn");
        if (!(this.options.tools ?? []).some((tool) => tool.name === params.tool)) throw new Error(`Unknown canvas tool: ${params.tool}`);
        this.emit("canvas_tool.requested", { id: request.id, ...params });
        let result: ToolResult;
        try {
          result = await this.options.onTool(params.tool, params.arguments);
        } catch (error) {
          result = { success: false, contentItems: [{ type: "inputText", text: errorMessage(error) }] };
        }
        // A late tool result must never answer a new process reusing the same request ID.
        if (this.child !== child || !this.incoming.has(request.id)) return;
        this.write({ id: request.id, result });
        this.incoming.delete(request.id);
        this.emit("canvas_tool.completed", { id: request.id, callId: params.callId, tool: params.tool, success: result.success });
      } else if (interactiveMethods.has(request.method)) {
        this.options.onApproval(request);
      } else {
        this.incoming.delete(request.id);
        this.write({ id: request.id, error: { code: -32601, message: `Unsupported client request: ${request.method}` } });
      }
    } catch (error) {
      if (this.child === child && this.incoming.has(request.id)) {
        this.incoming.delete(request.id);
        if (request.method === "item/tool/call") {
          this.write({ id: request.id, result: { success: false, contentItems: [{ type: "inputText", text: errorMessage(error) }] } });
        } else {
          this.write({ id: request.id, error: { code: -32603, message: errorMessage(error) } });
        }
      }
    }
  }

  private disconnected(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.connected = false;
    this.canvasToolsReady = false;
    this.connecting = null;
    this.lines?.close();
    this.lines = null;
    this.incoming.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RuntimeRequestError(reason, pending.method, true));
    }
    this.pending.clear();
    const previousTurnId = this.activeTurnId;
    this.activeTurnId = null;
    if (previousTurnId || this.starting) this.uncertainSubmission = true;
    this.emit("connection.changed", { state: "disconnected", reason, intentional: this.intentionalClose, activeTurnId: previousTurnId });
  }

  private requireConnected(): void {
    if (!this.connected || !this.child) throw new Error("Connect to Codex first");
  }

  private requireThread(): void {
    this.requireConnected();
    if (!this.threadId) throw new Error("Open a Codex session first");
  }

  private emit(type: string, payload: any): void {
    this.options.onEvent({ type, payload });
  }

  private readVersion(userAgent: string | undefined): Promise<string> {
    if (this.options.args) return Promise.resolve(userAgent ?? "unknown");
    return new Promise((resolve) => {
      execFile(this.options.command ?? "codex", ["--version"], { timeout: 5_000 }, (error, stdout) => {
        resolve(error ? "unknown" : stdout.match(/codex-cli\s+(\S+)/)?.[1] ?? "unknown");
      });
    });
  }
}

export { CodexRuntime as Runtime };

function promptInput(text: string, images: RuntimeImage[]) {
  // Generated by the installed app-server's generate-ts command: image user
  // input accepts a URL (including a data URL) alongside native text elements.
  for (const image of images) runtimeImageData(image);
  return [...(text || !images.length ? [{ type: "text", text, text_elements: [] }] : []),
    ...images.map(image => ({ type: 'image', url: image.url }))];
}

/** Validate hydrated local images before submitting a turn; never echo bytes in errors. */
export function runtimeImageData(image: RuntimeImage): string {
  const match = typeof image?.url === 'string' ? image.url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/) : null;
  if (!match || match[1] !== image.mimeType || match[2].length % 4 !== 0 || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) throw new Error('An attached image is invalid or uses an unsupported format. Attach a PNG, JPEG, GIF, or WebP image again.');
  return match[2];
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function modelMetadata(model: any): AgentModel {
  const result: AgentModel = { id: model.model ?? model.id, name: model.displayName ?? model.model ?? model.id };
  if (typeof model.description === 'string') result.description = model.description;
  if (typeof model.isDefault === 'boolean') result.isDefault = model.isDefault;
  if (typeof model.defaultReasoningEffort === 'string') result.defaultReasoningEffort = model.defaultReasoningEffort;
  if (Array.isArray(model.supportedReasoningEfforts)) result.supportedReasoningEfforts = model.supportedReasoningEfforts
    .filter((entry: any) => typeof entry?.reasoningEffort === 'string')
    .map((entry: any) => ({ reasoningEffort: entry.reasoningEffort, description: typeof entry.description === 'string' ? entry.description : '' }));
  if (typeof model.defaultServiceTier === 'string' || model.defaultServiceTier === null) result.defaultServiceTier = model.defaultServiceTier;
  if (Array.isArray(model.serviceTiers)) result.serviceTiers = model.serviceTiers
    .filter((entry: any) => typeof entry?.id === 'string' && typeof entry.name === 'string')
    .map((entry: any) => ({ id: entry.id, name: entry.name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }));
  else if (Array.isArray(model.additionalSpeedTiers)) result.serviceTiers = [
    { id: 'default', name: 'Standard' },
    ...model.additionalSpeedTiers.filter((id: unknown) => typeof id === 'string' && id !== 'default').map((id: string) => ({ id, name: id })),
  ];
  // Catalog speed lists describe optional accelerated tiers; the standard
  // service tier remains valid even when it is absent from that list.
  if (result.serviceTiers && !result.serviceTiers.some(tier => tier.id === 'default')) result.serviceTiers.unshift({ id: 'default', name: 'Standard' });
  return result;
}

/** Only expose known settings. Config may contain private provider or MCP credentials. */
function settingsDefaults(config: any): Partial<AgentSettings> {
  const result: Partial<AgentSettings> = {};
  if (!isRecord(config)) return result;
  for (const [native, local, allowed] of [
    ['model', 'model', null],
    ['model_reasoning_effort', 'reasoningEffort', null],
    ['service_tier', 'serviceTier', null],
    ['approval_policy', 'approvalPolicy', ['on-request', 'never', 'untrusted']],
    ['approvals_reviewer', 'approvalsReviewer', ['user', 'auto_review', 'guardian_subagent']],
    ['sandbox_mode', 'sandboxMode', ['read-only', 'workspace-write', 'danger-full-access']],
    ['web_search', 'webSearch', ['disabled', 'cached', 'indexed', 'live']],
    ['model_reasoning_summary', 'reasoningSummary', ['auto', 'concise', 'detailed', 'none']],
    ['model_verbosity', 'verbosity', ['low', 'medium', 'high']],
  ] as const) {
    const value = config[native];
    if (typeof value === 'string' && (!allowed || (allowed as readonly string[]).includes(value))) (result as Record<string, unknown>)[local] = value;
  }
  if (typeof config.sandbox_workspace_write?.network_access === 'boolean') result.networkAccess = config.sandbox_workspace_write.network_access;
  if (Array.isArray(config.sandbox_workspace_write?.writable_roots)) result.writableRoots = config.sandbox_workspace_write.writable_roots.filter((root: unknown) => typeof root === 'string');
  return result;
}

function settingsRequirements(requirements: any): SettingsRequirements {
  const result: SettingsRequirements = {};
  for (const key of ['allowedApprovalPolicies', 'allowedApprovalsReviewers', 'allowedSandboxModes', 'allowedWebSearchModes'] as const) {
    if (Array.isArray(requirements[key])) result[key] = requirements[key].filter((value: unknown) => typeof value === 'string');
  }
  return result;
}

/** Resume can retain historical values when overrides are absent. Resolve the
 * requested inheritance explicitly while leaving persisted/UI settings alone. */
function inheritedSettings(requested: AgentSettings, connection: RuntimeConnection | null): AgentSettings {
  const result = structuredClone(requested);
  const defaults = connection?.defaults;
  const overrides = requested.configOverrides;
  for (const [local, native] of [
    ['approvalPolicy', 'approval_policy'], ['approvalsReviewer', 'approvals_reviewer'],
    ['sandboxMode', 'sandbox_mode'], ['webSearch', 'web_search'],
    ['reasoningSummary', 'model_reasoning_summary'], ['verbosity', 'model_verbosity'],
  ] as const) {
    if (!requested[local] && !Object.hasOwn(overrides, native) && defaults?.[local]) (result as Record<string, unknown>)[local] = defaults[local];
  }
  const inherit = (local: 'model' | 'reasoningEffort' | 'serviceTier', native: string, fallback?: string | null): void => {
    if (requested[local]) return;
    if (Object.hasOwn(overrides, native)) {
      if (typeof overrides[native] === 'string') result[local] = overrides[native];
    } else if (fallback) result[local] = fallback;
  };
  inherit('model', 'model', defaults?.model || connection?.models.find(model => model.isDefault)?.id);
  const model = connection?.models.find(model => model.id === result.model);
  let effort = defaults?.reasoningEffort;
  if (effort && model?.supportedReasoningEfforts?.length && !model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) effort = undefined;
  inherit('reasoningEffort', 'model_reasoning_effort', effort || model?.defaultReasoningEffort);
  let tier = defaults?.serviceTier ? serviceTierForModel(model, defaults.serviceTier) : undefined;
  if (tier && model?.serviceTiers?.length && !model.serviceTiers.some(option => option.id === tier)) tier = undefined;
  inherit('serviceTier', 'service_tier', tier || model?.defaultServiceTier || (defaults ? 'default' : undefined));
  result.serviceTier = serviceTierForModel(model, result.serviceTier);
  return result;
}

function threadConfig(settings: AgentSettings, canvasMcp: RuntimeOptions['canvasMcp']): Record<string, any> {
  const config: Record<string, any> = structuredClone(settings.configOverrides);
  for (const [native, value] of [
    ['model', settings.model], ['service_tier', settings.serviceTier], ['approval_policy', settings.approvalPolicy],
    ['approvals_reviewer', settings.approvalsReviewer], ['sandbox_mode', settings.sandboxMode],
  ] as const) if (value) {
    setConfigPath(config, native, value);
    delete config[native]; // The dedicated top-level protocol field has precedence.
  }
  for (const [native, value] of [
    ['model_reasoning_effort', settings.reasoningEffort], ['model_reasoning_summary', settings.reasoningSummary],
    ['model_verbosity', settings.verbosity], ['web_search', settings.webSearch],
  ] as const) if (value) setConfigPath(config, native, value);
  if (settings.networkAccess !== null) setConfigPath(config, 'sandbox_workspace_write.network_access', settings.networkAccess);
  if (settings.writableRoots.length) setConfigPath(config, 'sandbox_workspace_write.writable_roots', settings.writableRoots);
  if (canvasMcp) setConfigPath(config, `mcp_servers.${canvasServerName}`, {
    url: canvasMcp.url(), bearer_token_env_var: canvasTokenEnvironment,
    required: true, startup_timeout_sec: 10, tool_timeout_sec: 30,
  });
  return config;
}

/** Remove both nested and dotted collisions before writing a native config key. */
function setConfigPath(config: Record<string, any>, path: string, value: unknown): void {
  for (const key of Object.keys(config)) {
    if (key === path || key.startsWith(`${path}.`)) delete config[key];
    else if (path.startsWith(`${key}.`)) {
      const nested = config[key];
      delete config[key];
      // Avoid overlapping parent/child overrides: their native map iteration
      // order need not match JavaScript insertion order.
      const preserveSiblings = (prefix: string, object: Record<string, any>): void => {
        for (const [child, childValue] of Object.entries(object)) {
          const childPath = `${prefix}.${child}`;
          if (childPath === path || childPath.startsWith(`${path}.`)) continue;
          if (path.startsWith(`${childPath}.`)) {
            if (isRecord(childValue)) preserveSiblings(childPath, childValue);
          } else if (!Object.hasOwn(config, childPath)) config[childPath] = childValue;
        }
      };
      if (isRecord(nested)) preserveSiblings(key, nested);
    }
  }
  config[path] = value;
}

function turnSettings(settings: AgentSettings | null, model: string | null, effort: string | null, sandbox: any, defaults?: Partial<AgentSettings>): Record<string, any> {
  if (!settings) return {};
  const result: Record<string, any> = {};
  if (settings.model) result.model = settings.model;
  if (settings.serviceTier) result.serviceTier = settings.serviceTier;
  if (settings.reasoningEffort) result.effort = settings.reasoningEffort;
  if (settings.reasoningSummary) result.summary = settings.reasoningSummary;
  if (settings.approvalPolicy) result.approvalPolicy = settings.approvalPolicy;
  if (settings.approvalsReviewer) result.approvalsReviewer = settings.approvalsReviewer;
  if (model) result.collaborationMode = { mode: settings.collaborationMode, settings: { model, reasoning_effort: effort, developer_instructions: null } };
  else if (settings.collaborationMode === 'plan') throw new Error('Select a model before starting Plan mode.');

  const inheritedMode = sandbox?.type === 'workspaceWrite' ? 'workspace-write' : sandbox?.type === 'readOnly' ? 'read-only' : sandbox?.type === 'dangerFullAccess' ? 'danger-full-access' : defaults?.sandboxMode;
  const mode = settings.sandboxMode || inheritedMode;
  if (settings.sandboxMode || settings.networkAccess !== null || settings.writableRoots.length) {
    const networkAccess = settings.networkAccess ?? sandbox?.networkAccess ?? defaults?.networkAccess ?? false;
    if (mode === 'workspace-write') result.sandboxPolicy = {
      type: 'workspaceWrite', networkAccess,
      writableRoots: settings.writableRoots.length ? settings.writableRoots : sandbox?.writableRoots ?? defaults?.writableRoots ?? [],
      excludeTmpdirEnvVar: sandbox?.excludeTmpdirEnvVar ?? false, excludeSlashTmp: sandbox?.excludeSlashTmp ?? false,
    };
    else if (mode === 'read-only') result.sandboxPolicy = { type: 'readOnly', networkAccess };
    else if (mode === 'danger-full-access') result.sandboxPolicy = { type: 'dangerFullAccess' };
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
