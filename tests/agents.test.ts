import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentRegistry } from '../src/server/agents.ts';
import { Store } from '../src/server/store.ts';
import { createApplication } from '../src/server/app.ts';
import { agentDefinitionSchema } from '../src/shared/agents.ts';
import type { RuntimeOptions } from '../src/server/runtime.ts';

test('agent configurations validate endpoints and separate environment names from values', () => {
  for (const patch of [
    { kind: 'acp' },
    { kind: 'openai-compatible', baseUrl: 'https://example.com/v1' },
    { kind: 'openai-compatible', model: 'model', baseUrl: 'http://example.com/v1' },
    { kind: 'openai-compatible', model: 'model', baseUrl: 'https://secret@example.com/v1' },
    { kind: 'openai-compatible', model: 'model', baseUrl: 'https://example.com/v1?key=secret' },
    { kind: 'acp', command: 'agent', env: { TOKEN: 'literal-secret-value' } },
  ]) assert.equal(agentDefinitionSchema.safeParse({ id: 'test', name: 'Test', ...patch }).success, false);
  assert.ok(agentDefinitionSchema.safeParse({ id: 'local', name: 'Local', kind: 'openai-compatible', model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1' }).success);
});

test('API keys are write-only process memory and never saved with configuration', () => {
  const values = new Map<string, any>();
  const storage = { get: <T>(key: string) => values.get(key) as T | undefined, set: (key: string, value: any) => { values.set(key, structuredClone(value)); } };
  const registry = new AgentRegistry(storage);
  const configuration = { id: 'provider', name: 'My model', kind: 'anthropic', model: 'custom-model' };
  registry.save({ ...configuration, apiKey: 'private-credential' });
  assert.equal(registry.key('provider'), 'private-credential');
  assert.equal(registry.list().find(agent => agent.id === 'provider')?.credentialConfigured, true);
  assert.ok(!JSON.stringify(registry.list()).includes('private-credential'));
  assert.ok(!JSON.stringify([...values]).includes('private-credential'));
  assert.equal(new AgentRegistry(storage).key('provider'), undefined);
  registry.save({ ...configuration, apiKey: '' });
  assert.equal(registry.key('provider'), undefined);
});

class FakeRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  closed = false;
  steers: string[] = [];
  constructor(readonly options: RuntimeOptions) {}
  async connect() { return { authenticated: true, models: [], version: 'test-agent' }; }
  async open(id?: string) { this.threadId = id ?? 'native-session'; return this.threadId; }
  async start(_text: string) { this.activeTurnId = 'native-turn'; this.options.onEvent({ type: 'turn/started', payload: { turn: { id: this.activeTurnId } } }); return this.activeTurnId; }
  async steer(text: string) { this.steers.push(text); }
  async interrupt() { this.complete(); }
  answer() {}
  close() { this.closed = true; }
  complete() { const id = this.activeTurnId; this.activeTurnId = null; this.options.onEvent({ type: 'turn/completed', payload: { turn: { id, status: 'completed' } } }); }
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'canvagent-agents-'));
  const workspace = join(directory, 'project'); mkdirSync(workspace);
  const runtimes: FakeRuntime[] = [];
  const dataDir = join(directory, 'data');
  const app = createApplication({ workspace, dataDir, runtimeCommand: '/auto-discovered/codex', runtimeFactory: options => { const runtime = new FakeRuntime(options); runtimes.push(runtime); return runtime; } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${base}/api/state`);
  const cookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
  const initial = await bootstrap.json();
  async function request(path: string, body?: any) {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { app, request, initial, runtimes, dataDir };
}

test('existing sessions migrate to Codex and blank conversations switch agents in place', async t => {
  const f = await fixture(t);
  const id = f.initial.activeSessionId;
  assert.equal(f.initial.sessions[0].agentId, 'codex');
  const selected = await f.request(`/api/sessions/${id}/agent`, { agentId: 'opencode' });
  assert.equal(selected.status, 200); assert.equal(selected.body.id, id);
  assert.equal(selected.body.threadId, null); assert.deepEqual(selected.body.messages, []);
  const state = (await f.request('/api/state')).body;
  assert.equal(state.defaultAgentId, 'opencode');
  assert.equal(state.runtime.agentId, 'opencode'); assert.equal(state.runtime.connected, false);
  assert.equal((await f.request('/api/sessions', {})).body.agentId, 'opencode');
});

test('switching an agent with native history creates a new conversation and preserves the old binding', async t => {
  const f = await fixture(t); const id = f.initial.activeSessionId;
  await f.request(`/api/sessions/${id}/messages`, { text: 'Start my task', requestId: 'first' });
  const busy = await f.request(`/api/sessions/${id}/agent`, { agentId: 'claude' });
  assert.equal(busy.status, 409);
  f.runtimes[0].complete();
  const selected = await f.request(`/api/sessions/${id}/agent`, { agentId: 'claude' });
  assert.equal(selected.status, 200); assert.notEqual(selected.body.id, id);
  const sessions = (await f.request('/api/state')).body.sessions;
  assert.equal(sessions.find((item: any) => item.id === id).threadId, 'native-session');
  assert.equal(sessions.find((item: any) => item.id === id).agentId, 'codex');
  assert.equal(selected.body.agentId, 'claude'); assert.equal(selected.body.threadId, null);
});

test('connection readiness is scoped to the active conversation and ACP updates queue', async t => {
  const f = await fixture(t); const id = f.initial.activeSessionId;
  await f.request('/api/runtime/connect', { sessionId: id });
  const next = (await f.request('/api/sessions', { agentId: 'opencode' })).body;
  let state = (await f.request('/api/state')).body;
  assert.equal(state.runtime.connected, false, 'A ready Codex session cannot imply a ready ACP session.');
  await f.request(`/api/sessions/${next.id}/messages`, { text: 'First', requestId: 'one' });
  await f.request(`/api/sessions/${next.id}/messages`, { text: 'Second', requestId: 'two' });
  assert.deepEqual(f.runtimes[1].steers, []);
  state = (await f.request('/api/state')).body;
  assert.equal(state.sessions.find((item: any) => item.id === next.id).queued.length, 1);
  assert.equal(state.runtime.capabilities.steering, false);
  await f.request(`/api/sessions/${id}/activate`, {});
  assert.equal((await f.request('/api/state')).body.runtime.capabilities.steering, true);
});

test('agent API persists definitions without credentials and protects native ownership', async t => {
  const f = await fixture(t); const id = f.initial.activeSessionId;
  const configuration = { id: 'custom', name: 'Custom', kind: 'openai-compatible', model: 'my-model', baseUrl: 'https://example.com/v1', apiKey: 'never-save-this' };
  assert.equal((await f.request('/api/agents', configuration)).status, 200);
  assert.ok(!JSON.stringify((await f.request('/api/state')).body).includes('never-save-this'));
  assert.ok(!JSON.stringify(f.app.store.get('agents')).includes('never-save-this'));
  assert.equal((await f.request('/api/agents')).body.agents.find((agent: any) => agent.id === 'custom').credentialConfigured, true);
  await f.request(`/api/sessions/${id}/agent`, { agentId: 'custom' });
  await f.request(`/api/sessions/${id}/messages`, { text: 'Test', requestId: 'one' });
  assert.equal((await f.request('/api/agents', configuration)).status, 409, 'Cannot replace live provider config.');
  f.runtimes[0].complete();
  assert.equal((await f.request('/api/agents/custom/remove', {})).status, 409, 'Saved native sessions keep their configuration.');
  assert.equal((await f.request('/api/agents', { id: 'custom', name: 'Wrong harness', kind: 'acp', command: 'other' })).status, 409);
});

test('unknown and reserved agent configurations fail without changing saved state', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`/api/sessions/${f.initial.activeSessionId}/agent`, { agentId: 'missing' })).status, 404);
  assert.equal((await f.request('/api/agents', { id: 'fake-codex', name: 'Fake', kind: 'codex' })).status, 400);
  assert.equal((await f.request('/api/state')).body.sessions[0].agentId, 'codex');
});

test('resetting a built-in override cannot rebind saved API history to a different harness', async t => {
  const f = await fixture(t); const id = f.initial.activeSessionId;
  assert.equal((await f.request('/api/agents', { id: 'claude', name: 'Claude API', kind: 'anthropic', model: 'my-model' })).status, 200);
  await f.request(`/api/sessions/${id}/agent`, { agentId: 'claude' });
  await f.request(`/api/sessions/${id}/messages`, { text: 'Test', requestId: 'override' });
  f.runtimes[0].complete();
  assert.equal((await f.request('/api/agents/claude/remove', {})).status, 409);
  assert.equal((await f.request('/api/state')).body.agents.find((agent: any) => agent.id === 'claude').kind, 'anthropic');
});

test('changing API endpoints clears the ephemeral key and preserves explicit credential association', () => {
  const values = new Map<string, any>();
  const storage = { get: <T>(key: string) => values.get(key) as T | undefined, set: (key: string, value: any) => { values.set(key, structuredClone(value)); } };
  const registry = new AgentRegistry(storage);
  const config = { id: 'custom', name: 'Custom', kind: 'openai-compatible', model: 'test', baseUrl: 'https://one.example/v1' };
  registry.save({ ...config, apiKey: 'host-one-key' });
  registry.save({ ...config, baseUrl: 'https://two.example/v1' });
  assert.equal(registry.key('custom'), undefined);
  registry.save({ ...config, apiKeyEnv: 'EXPLICIT_KEY' });
  assert.throws(() => registry.save({ ...config, baseUrl: 'https://three.example/v1', apiKeyEnv: 'EXPLICIT_KEY' }), /endpoint changed/);
  assert.equal(registry.get('custom').baseUrl, config.baseUrl);
});

test('explicit Codex executable configuration takes precedence over desktop discovery', async t => {
  const f = await fixture(t);
  await f.request('/api/runtime/connect', {});
  assert.equal(f.runtimes[0].options.command, '/auto-discovered/codex');
  assert.equal((await f.request('/api/agents', { id: 'codex', name: 'Codex', kind: 'codex', command: '/custom/codex', args: ['app-server', '--custom-flag'] })).status, 200);
  await f.request('/api/runtime/connect', {});
  assert.equal(f.runtimes[1].options.command, '/custom/codex');
  assert.deepEqual(f.runtimes[1].options.args, ['app-server', '--custom-flag']);
});

test('editing API model defaults updates inherited conversation models and preserves explicit overrides', async t => {
  const f = await fixture(t);
  const config = { id: 'api', name: 'API', kind: 'openai-compatible', model: 'first-model', baseUrl: 'http://localhost:9999/v1' };
  await f.request('/api/agents', config);
  const first = (await f.request('/api/sessions', { agentId: 'api' })).body;
  const second = (await f.request('/api/sessions', { agentId: 'api' })).body;
  await f.request(`/api/sessions/${second.id}/settings`, { model: 'explicit-model' });
  await f.request('/api/agents', { ...config, model: 'new-default' });
  const sessions = (await f.request('/api/state')).body.sessions;
  assert.equal(sessions.find((session: any) => session.id === first.id).settings.model, 'new-default');
  assert.equal(sessions.find((session: any) => session.id === second.id).settings.model, 'explicit-model');
});
