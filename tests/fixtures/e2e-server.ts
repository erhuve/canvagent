/** Browser-only fixture. The product always uses the real CodexRuntime. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../../src/server/app.js';
import type { RuntimeOptions } from '../../src/server/runtime.js';

function textResult(result: any) {
  if (!result.success) throw new Error(JSON.stringify(result.contentItems));
  return JSON.parse(result.contentItems.find((item: any) => item.type === 'inputText').text);
}

class BrowserFixtureRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  private sequence = 0;
  constructor(private options: RuntimeOptions) {}
  async connect() {
    return { authenticated: true, version: 'browser-test-fixture', models: [{ id: 'browser-fixture', name: 'Browser fixture' }] };
  }
  async open(threadId?: string) { this.threadId = threadId || `browser-thread-${randomUUID()}`; return this.threadId; }
  async start(text: string) {
    const turnId = `browser-turn-${++this.sequence}`;
    this.activeTurnId = turnId;
    this.options.onEvent({ type: 'turn/started', payload: { threadId: this.threadId, turn: { id: turnId } } });
    setTimeout(() => void this.run(text, turnId), 30);
    return turnId;
  }
  private async run(text: string, turnId: string) {
    try {
      const read = textResult(await this.options.onTool('read_canvas', { scope: 'overview' }));
      if (text.includes('[regional-capture]')) {
        const near = read.elements.find((element: any) => element.type === 'rectangle');
        if (!near) throw new Error('Draw a nearby rectangle before the regional capture check.');
        const region = { x: near.x - 20, y: near.y - 20, width: near.width + 40, height: near.height + 40 };
        const before = await this.options.onTool('capture_region', { region });
        if (!before.success) throw new Error('Initial regional capture failed.');
        textResult(await this.options.onTool('apply_canvas_ops', { requestId: `distant-${turnId}`, observedBoardRevision: read.revision, operations: [{ kind: 'create', elementId: `capture-distant-${turnId}`, shape: 'rectangle', x: 100000, y: 100000, width: 200, height: 100 }] }));
        const after = await this.options.onTool('capture_region', { region });
        if (!after.success) throw new Error('Regional capture with a distant object failed.');
        const blank = await this.options.onTool('capture_region', { region: { x: -500000, y: -500000, width: 10000, height: 10000 } });
        if (!blank.success) throw new Error('Large blank-region capture failed.');
        this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `regional-${turnId}`, delta: 'Regional capture checks complete.' } });
        this.complete();
        return;
      }
      const capture = await this.options.onTool('capture_region', {});
      if (!capture.success || !capture.contentItems.some((item: any) => item.type === 'inputImage' && item.imageUrl?.startsWith('data:image/png;base64,'))) throw new Error('The real browser did not return a canvas PNG.');
      if (text.includes('[race]')) {
        this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `ready-${turnId}`, delta: 'Race fixture ready: draw now while I prepare an annotation.' } });
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      const original = read.elements.find((element: any) => element.type === 'rectangle');
      textResult(await this.options.onTool('apply_canvas_ops', { requestId: `fixture-note-${turnId}`, observedBoardRevision: read.revision,
        operations: [{ kind: 'create', elementId: `agent-note-${turnId}`, shape: 'text', text: 'An editable note from Codex', x: original ? original.x + original.width + 30 : 260, y: original?.y ?? 180, fontSize: 20 }] }));
      this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `reply-${turnId}`, delta: 'I inspected the saved board and its rendered image, then added an editable note. I will keep working while you draw.' } });
      if (!text.toLowerCase().includes('keep working')) this.complete();
    } catch (error) {
      this.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: this.threadId, turnId, itemId: `error-${turnId}`, delta: `Fixture tool failure: ${String(error)}` } });
      this.complete('failed');
    }
  }
  async steer(_text: string, expectedTurnId: string) {
    if (expectedTurnId !== this.activeTurnId) throw new Error('Notice targeted a stale turn.');
  }
  async interrupt() { this.complete('interrupted'); }
  answer() {}
  close() { this.activeTurnId = null; }
  private complete(status = 'completed') {
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.options.onEvent({ type: 'turn/completed', payload: { threadId: this.threadId, turn: { id: turnId, status } } });
  }
}

const directory = mkdtempSync(join(tmpdir(), 'canvagent-browser-'));
const workspace = join(directory, 'browser-workspace');
mkdirSync(workspace);
const application = createApplication({ workspace, dataDir: join(directory, 'data'), port: 4319, distDir: resolve('dist'), runtimeFactory: configuration => new BrowserFixtureRuntime(configuration) as any });
application.server.listen(4319, '127.0.0.1', () => console.log('Browser fixture ready: http://127.0.0.1:4319'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void application.close().finally(() => { rmSync(directory, { recursive: true, force: true }); process.exit(0); });
});
