/** Browser-only fixture. The product always uses the real CodexRuntime. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceHost } from '../../src/server/workspaces.js';
import type { RuntimeOptions } from '../../src/server/runtime.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function textResult(result: any) {
  if (!result.success) throw new Error(JSON.stringify(result.contentItems));
  return JSON.parse(result.contentItems.find((item: any) => item.type === 'inputText').text);
}

class BrowserFixtureRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  private approvalId: string | undefined;
  private canvasClient: Client | undefined;
  constructor(private options: RuntimeOptions) {}
  async connect() {
    return { authenticated: true, version: 'browser-test-fixture',
      defaults: { model: 'browser-fixture', reasoningEffort: 'medium', serviceTier: 'default' },
      models: [{ id: 'browser-fixture', name: 'Browser fixture', isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick tasks' }, { reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'high', description: 'Deeper thinking' }],
        defaultServiceTier: 'default', serviceTiers: [{ id: 'default', name: 'Standard' }, { id: 'fast', name: 'Fast' }] },
      { id: 'browser-light', name: 'Browser light', defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Lightweight thinking' }],
        defaultServiceTier: 'default', serviceTiers: [{ id: 'default', name: 'Standard' }] }],
    };
  }
  async open(threadId?: string) {
    await this.canvasClient?.close();
    this.threadId = threadId || `browser-thread-${randomUUID()}`;
    if (this.options.canvasMcp) {
      this.canvasClient = new Client({ name: 'browser-fixture', version: '1.0.0' });
      await this.canvasClient.connect(new StreamableHTTPClientTransport(new URL(this.options.canvasMcp.url()), {
        requestInit: { headers: { Authorization: `Bearer ${this.options.canvasMcp.token}` } },
      }));
      await this.canvasClient.listTools();
      this.options.onEvent({ type: 'canvas_tools.ready', payload: { threadId: this.threadId, resumed: Boolean(threadId) } });
    }
    return this.threadId;
  }
  private async callCanvasTool(name: string, args: any) {
    if (!this.canvasClient) return this.options.onTool(name, args);
    const result = await this.canvasClient.callTool({ name, arguments: args });
    return { success: !result.isError, contentItems: (result.content as any[]).map(item => item.type === 'image'
      ? { type: 'inputImage', imageUrl: `data:${item.mimeType};base64,${item.data}` }
      : { type: 'inputText', text: item.text }) };
  }
  async start(text: string) {
    const turnId = `browser-turn-${randomUUID()}`;
    this.activeTurnId = turnId;
    this.options.onEvent({ type: 'turn/started', payload: { threadId: this.threadId, turn: { id: turnId } } });
    setTimeout(() => void this.run(text, turnId), 30);
    return turnId;
  }
  private async run(text: string, turnId: string) {
    try {
      if (text.includes('[chat-failure]')) {
        this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `failed-${turnId}`, delta: 'The fixture could not finish this turn.' } });
        this.complete('failed');
        return;
      }
      if (text.includes('[computer-use-approval]')) {
        this.approvalId = turnId;
        this.options.onApproval({ id: turnId, method: 'mcpServer/elicitation/request', params: {
          threadId: this.threadId, turnId, serverName: 'cua_repl', mode: 'form',
          message: 'Allow Computer Use to use "Google Chrome"?', requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call', connector_name: 'Computer Use', persist: ['session', 'always'], subtitle: 'Carefully monitor the app while Computer Use works.' },
        } });
        return;
      }
      if (text.includes('[chat-approval]')) {
        this.approvalId = turnId;
        this.options.onApproval({ id: turnId, method: 'item/commandExecution/requestApproval', params: {
          threadId: this.threadId, turnId, command: 'echo "browser approval check"',
          reason: 'Allow this test command?', availableDecisions: ['accept', 'decline'],
        } });
        return;
      }
      if (text.includes('[chat]')) {
        const itemId = `chat-${turnId}`;
        this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId, delta: 'A **streamed** reply' } });
        await new Promise(resolve => setTimeout(resolve, 180));
        this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId, delta: '\n\n```ts\nconst canvas = "shared";\n```' } });
        if (text.includes('[project-background]')) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId, delta: '\n\nBackground project reply finished.' } });
        }
        if (!text.toLowerCase().includes('keep working')) this.complete();
        return;
      }
      const read = textResult(await this.callCanvasTool('read_canvas', { scope: 'overview' }));
      if (text.includes('[freehand]')) {
        textResult(await this.callCanvasTool('apply_canvas_ops', { requestId: `freehand-${turnId}`, observedBoardRevision: read.revision, operations: [
          { kind: 'create', elementId: `ribbon-${turnId}`, shape: 'freedraw', x: 240, y: 200,
            points: [[0, 0], [-45, -50], [-95, -15], [-120, 40], [-70, 80], [0, 50], [55, 5], [90, 45], [55, 85], [0, 50]], strokeColor: '#b63270', strokeWidth: 6, groupIds: ['ink-drawing'] },
          { kind: 'create', elementId: `pressure-${turnId}`, shape: 'freedraw', x: 380, y: 200,
            points: [[0, 0], [40, -45], [80, 0], [40, 45], [0, 0]], pressures: [.15, .5, 1, .7, .2], strokeColor: '#286e62', strokeWidth: 10, groupIds: ['ink-drawing'] },
          { kind: 'create', elementId: `outline-${turnId}`, shape: 'line', x: 240, y: 400,
            points: [[0, 0], [-70, -30], [-40, -100], [40, -80], [80, -10], [0, 0]], strokeColor: '#80611d', backgroundColor: '#ffedbd', fillStyle: 'hachure', roughness: .5 },
          { kind: 'create', elementId: `path-${turnId}`, shape: 'arrow', x: 460, y: 420,
            points: [[0, 0], [-30, -50], [15, -90]], strokeColor: '#4770ac', strokeWidth: 3 },
        ] }));
        const capture = await this.callCanvasTool('capture_region', {});
        if (!capture.success) throw new Error('Freehand capture failed.');
        this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `freehand-${turnId}`, delta: 'Freehand strokes and custom paths are on the canvas.' } });
        this.complete();
        return;
      }
      if (text.includes('[regional-capture]')) {
        const near = read.elements.find((element: any) => element.type === 'rectangle');
        if (!near) throw new Error('Draw a nearby rectangle before the regional capture check.');
        const region = { x: near.x - 20, y: near.y - 20, width: near.width + 40, height: near.height + 40 };
        const before = await this.callCanvasTool('capture_region', { region });
        if (!before.success) throw new Error('Initial regional capture failed.');
        textResult(await this.callCanvasTool('apply_canvas_ops', { requestId: `distant-${turnId}`, observedBoardRevision: read.revision, operations: [{ kind: 'create', elementId: `capture-distant-${turnId}`, shape: 'rectangle', x: 100000, y: 100000, width: 200, height: 100 }] }));
        const after = await this.callCanvasTool('capture_region', { region });
        if (!after.success) throw new Error('Regional capture with a distant object failed.');
        const blank = await this.callCanvasTool('capture_region', { region: { x: -500000, y: -500000, width: 10000, height: 10000 } });
        if (!blank.success) throw new Error('Large blank-region capture failed.');
        this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `regional-${turnId}`, delta: 'Regional capture checks complete.' } });
        this.complete();
        return;
      }
      const capture = await this.callCanvasTool('capture_region', {});
      if (!capture.success || !capture.contentItems.some((item: any) => item.type === 'inputImage' && item.imageUrl?.startsWith('data:image/png;base64,'))) throw new Error('The real browser did not return a canvas PNG.');
      if (text.includes('[race]')) {
        this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `ready-${turnId}`, delta: 'Race fixture ready: draw now while I prepare an annotation.' } });
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      const original = read.elements.find((element: any) => element.type === 'rectangle');
      textResult(await this.callCanvasTool('apply_canvas_ops', { requestId: `fixture-note-${turnId}`, observedBoardRevision: read.revision,
        operations: [{ kind: 'create', elementId: `agent-note-${turnId}`, shape: 'text', text: 'An editable note from Codex', x: original ? original.x + original.width + 30 : 260, y: original?.y ?? 180, fontSize: 20 }] }));
      this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `reply-${turnId}`, delta: 'I inspected the saved board and its rendered image, then added an editable note. I will keep working while you draw.' } });
      if (!text.toLowerCase().includes('keep working')) this.complete();
    } catch (error) {
      this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `error-${turnId}`, delta: `Fixture tool failure: ${String(error)}` } });
      this.complete('failed');
    }
  }
  async steer(text: string, expectedTurnId: string) {
    if (expectedTurnId !== this.activeTurnId) throw new Error('Notice targeted a stale turn.');
    if (!text.includes('Canvagent resource update')) this.options.onEvent({ type: 'item/agentMessage/delta', payload: {
      threadId: this.threadId, turnId: expectedTurnId, itemId: `update-${expectedTurnId}`, delta: 'Update received by the active turn.',
    } });
  }
  async interrupt() { this.complete('interrupted'); }
  answer(id: string, result: any) {
    if (id !== this.approvalId) throw new Error('Unknown approval.');
    if (result.action === 'accept' && JSON.stringify(result.content) !== '{}') throw new Error('An accepted permission form needs empty object content.');
    this.approvalId = undefined;
    // Native app-server notifications arrive after the approval reply is sent.
    queueMicrotask(() => {
      this.options.onEvent({ type: 'item/agentMessage/delta', payload: {
        threadId: this.threadId, turnId: this.activeTurnId, itemId: `approval-${id}`, delta: `Approval decision: ${result.action ?? result.decision}.`,
      } });
      this.complete();
    });
  }
  close() { this.activeTurnId = null; void this.canvasClient?.close().catch(() => {}); }
  private complete(status = 'completed') {
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.options.onEvent({ type: 'turn/completed', payload: { threadId: this.threadId, turn: { id: turnId, status } } });
  }
}

const directory = mkdtempSync(join(tmpdir(), 'canvagent-browser-'));
const workspace = join(directory, 'browser-workspace');
const secondWorkspace = join(directory, 'second-workspace');
mkdirSync(workspace);
mkdirSync(secondWorkspace);
for (const [folder, name] of [[workspace, 'browser-workspace'], [secondWorkspace, 'second-workspace']]) {
  mkdirSync(join(folder, 'src'));
  mkdirSync(join(folder, 'notes'));
  writeFileSync(join(folder, 'README.md'), `# ${name}\n\nFiles belong to ${name}.\n`);
  writeFileSync(join(folder, 'src', 'example.ts'), `export const greeting = "Hello from ${name}";\n`);
  writeFileSync(join(folder, 'notes', 'draft.txt'), `Draft notes for ${name}.\n`);
  writeFileSync(join(folder, 'notes', 'conflict.txt'), `Original text from ${name}.\n`);
  writeFileSync(join(folder, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
}
const application = createWorkspaceHost({ workspace, dataRoot: join(directory, 'data'), port: 4319, distDir: resolve('dist'), runtimeFactory: configuration => new BrowserFixtureRuntime(configuration) as any });
application.server.listen(4319, '127.0.0.1', async () => {
  try {
    const bootstrap = await fetch('http://127.0.0.1:4319/api/projects');
    const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const added = await fetch('http://127.0.0.1:4319/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ workspace: secondWorkspace }),
    });
    if (!added.ok) throw new Error(`Could not register the second fixture project: ${await added.text()}`);
    console.log('Browser fixture ready: http://127.0.0.1:4319');
  } catch (error) {
    console.error(error);
    await application.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(1);
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void application.close().finally(() => { rmSync(directory, { recursive: true, force: true }); process.exit(0); });
});
