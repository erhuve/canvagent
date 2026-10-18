import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export type RpcId = string | number;
export type RuntimeEvent = { type: string; payload: any };
export type ToolResult = { contentItems: any[]; success: boolean };
export type CanvasTool = { name: string; description: string; inputSchema: any };
export type ApprovalRequest = { id: RpcId; method: string; params: any };

export interface RuntimeOptions {
  cwd: string;
  model?: string;
  tools?: CanvasTool[];
  developerInstructions?: string;
  onEvent: (event: RuntimeEvent) => void;
  onTool: (name: string, args: any) => Promise<ToolResult>;
  onApproval: (request: ApprovalRequest) => void;
  /** Subprocess injection is useful for installations and protocol tests. No shell is used. */
  command?: string;
  args?: string[];
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

/** Codex app-server 0.159.2 newline-delimited JSON-RPC over local stdio. */
export class CodexRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private incoming = new Map<RpcId, ApprovalRequest>();
  private terminalTurns = new Set<string>();
  private connecting: Promise<{ authenticated: boolean; models: { id: string; name: string }[]; version: string }> | null = null;
  private connected = false;
  private starting = false;
  private opening = false;
  private uncertainSubmission = false;
  private intentionalClose = false;
  private generation = 0;

  constructor(private readonly options: RuntimeOptions) {}

  connect(): Promise<{ authenticated: boolean; models: { id: string; name: string }[]; version: string }> {
    if (this.connecting) return this.connecting;
    this.intentionalClose = false;
    const generation = ++this.generation;
    this.emit("connection.changed", { state: "connecting" });
    const child = spawn(this.options.command ?? "codex", this.options.args ?? ["app-server"], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit the runtime's configured authentication; never read credential files here.
      env: process.env,
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
        const [account, firstPage, version] = await Promise.all([
          this.request("account/read", { refreshToken: false }),
          this.request("model/list", { limit: 100 }),
          this.readVersion(initialized.userAgent),
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
        const result = {
          authenticated: Boolean(account.account) || account.requiresOpenaiAuth === false,
          models: modelRows.map((model: any) => ({ id: model.model ?? model.id, name: model.displayName ?? model.model ?? model.id })),
          version,
        };
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
    try {
      const common = {
        cwd: this.options.cwd,
        ...(this.options.model ? { model: this.options.model } : {}),
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ...(this.options.developerInstructions ? { developerInstructions: this.options.developerInstructions } : {}),
      };
      const response = threadId
        ? await this.request("thread/resume", { ...common, threadId })
        : await this.request("thread/start", {
            ...common,
            // Experimental in 0.159.2; these are native dynamic tools, not MCP names.
            dynamicTools: (this.options.tools ?? []).map((tool) => ({ type: "function", ...tool })),
          });
      if (typeof response.thread?.id !== "string") throw new Error("Codex returned a thread without an ID");
      this.threadId = response.thread.id;
      this.activeTurnId = response.thread.turns?.find((turn: any) => turn.status === "inProgress")?.id ?? null;
      this.uncertainSubmission = false;
      this.emit("thread.opened", { threadId: this.threadId, resumed: Boolean(threadId), activeTurnId: this.activeTurnId });
      return this.threadId!;
    } finally {
      this.opening = false;
    }
  }

  async start(text: string, requestId?: string): Promise<string> {
    this.requireThread();
    if (this.opening || this.starting || this.activeTurnId) throw new Error("A Codex turn is already active");
    if (this.uncertainSubmission) throw new Error("The previous submission outcome is unknown; resume the existing thread before sending again");
    this.starting = true;
    try {
      const response = await this.request("turn/start", {
        threadId: this.threadId,
        input: textInput(text),
        ...(requestId ? { clientUserMessageId: requestId } : {}),
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

  async steer(text: string, expectedTurnId: string): Promise<void> {
    this.requireThread();
    if (this.activeTurnId !== expectedTurnId) throw new Error("The requested Codex turn is no longer active");
    await this.request("turn/steer", { threadId: this.threadId, expectedTurnId, input: textInput(text) });
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

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
