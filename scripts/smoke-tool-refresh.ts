/** Manual compatibility check against an installed Codex CLI. The inference
 * provider is a local error stub: no model requests leave this process. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { handleCanvasMcp } from '../src/server/canvas-mcp.js';
import { canvasToolSpecs } from '../src/server/canvas-tools.js';
import { CodexRuntime, type RuntimeEvent } from '../src/server/runtime.js';

const directory = mkdtempSync(join(tmpdir(), 'canvagent-tool-refresh-'));
const token = randomBytes(32).toString('hex');
const app = express();
const http = createServer(app);
app.use(express.json());
app.post('/v1/responses', (_req, res) => res.status(400).json({ error: { type: 'invalid_request_error', message: 'This local test intentionally skips inference.' } }));
app.all('/mcp', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return res.status(401).end();
  if (req.method !== 'POST') return res.status(405).end();
  await handleCanvasMcp(req, res, canvasToolSpecs, async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'Local tool bridge verified.' }] }));
});
await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
const address = http.address(); assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const candidates = ['/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'];
const command = process.env.CANVAGENT_CODEX_BIN ?? candidates.find(path => existsSync(path)) ?? 'codex';
const args = ['app-server', '-c', 'mcp_servers={}', '-c', 'model_provider="canvagent_probe"', '-c',
  `model_providers.canvagent_probe={name="Local protocol probe",base_url="${base}/v1",wire_api="responses",requires_openai_auth=false}`];
const legacyEvents: RuntimeEvent[] = [];
const events: RuntimeEvent[] = [];
const makeRuntime = (legacy: boolean) => new CodexRuntime({
  cwd: directory, command, args,
  tools: legacy ? [{ name: 'legacy_canvas', description: 'An old saved drawing tool', inputSchema: { type: 'object', properties: {} } }] : canvasToolSpecs,
  ...(!legacy ? { canvasMcp: { url: () => `${base}/mcp`, token } } : {}),
  onEvent: event => (legacy ? legacyEvents : events).push(event), onApproval: () => {},
  onTool: async () => ({ success: true, contentItems: [] }),
});
const oldRuntime = makeRuntime(true), upgraded = makeRuntime(false);
let threadId: string | undefined;
async function waitFor(events: RuntimeEvent[], type: string) {
  const deadline = Date.now() + 10000;
  while (!events.some(event => event.type === type)) {
    if (Date.now() > deadline) throw new Error(`Did not receive ${type}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
try {
  await oldRuntime.connect();
  threadId = await oldRuntime.open();
  const marker = `Preserve this conversation context: ${randomBytes(8).toString('hex')}`;
  await oldRuntime.start(marker);
  await waitFor(legacyEvents, 'turn/completed');
  oldRuntime.close();
  const connection = await upgraded.connect();
  assert.equal(await upgraded.open(threadId), threadId);
  // Inspection-only RPCs are used here to check Codex's native persistence and
  // discovery contracts; the application doesn't reconstruct conversation items.
  const inspect = (method: string, params: unknown) => (upgraded as any).request(method, params);
  const history = await inspect('thread/items/list', { threadId, limit: 100, sortDirection: 'asc' });
  assert.ok(JSON.stringify(history).includes(marker), 'The native user message must survive resuming.');
  const inventory = await inspect('mcpServerStatus/list', { threadId, serverName: 'canvagent_canvas' });
  const tools = inventory.data.find((server: any) => server.name === 'canvagent_canvas').tools;
  assert.ok(JSON.stringify(tools.apply_canvas_ops.inputSchema).includes('freedraw'));
  const bridge = await inspect('mcpServer/tool/call', { threadId, server: 'canvagent_canvas', tool: 'read_canvas', arguments: {} });
  assert.ok(JSON.stringify(bridge).includes('Local tool bridge verified.'));
  assert.ok(events.some(event => event.type === 'canvas_tools.ready' && event.payload.resumed));
  console.log(JSON.stringify({ version: connection.version, sameNativeThread: true, nativeContextRetained: true, currentCanvasTools: Object.keys(tools).length, freehandAvailable: true, authenticatedToolBridge: true }, null, 2));
} finally {
  if (threadId) await (upgraded as any).request('thread/archive', { threadId }).catch(() => {});
  oldRuntime.close(); upgraded.close();
  await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
  rmSync(directory, { recursive: true, force: true });
}
