import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/server/app.js';

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const value = read(); if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for API application integration.');
}

test('a real API conversation routes workspace permission decisions before file changes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'canvagent-api-application-'));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const providerRequests: any[] = [];
  const toolCall = (path: string) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: `create-${path}`, type: 'function', function: { name: 'workspace_create', arguments: JSON.stringify({ path, content: `Contents of ${path}\n` }) } }] } }] });
  const answer = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
  const responses = [toolCall('denied.txt'), answer('The file was left unchanged.'), toolCall('approved.txt'), answer('Created approved.txt.'), toolCall('cancelled.txt')];
  const provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    providerRequests.push({ body, authorization: request.headers.authorization });
    if (providerRequests.length === 6) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'A credential reflected by a failing proxy must stay private.' } }));
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(responses[providerRequests.length - 1] ?? answer('Unexpected provider request.')));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress === 'object');
  const application = createApplication({ workspace, dataDir: join(directory, 'data') });
  t.after(async () => {
    await application.close();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${base}/api/state`);
  const cookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
  const initial = await bootstrap.json();
  const sessionId = initial.activeSessionId;
  const session = () => application.state().sessions.find(item => item.id === sessionId)!;
  async function post(path: string, body: any) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await post('/api/agents', { id: 'local-api', name: 'Local test provider', kind: 'openai-compatible', model: 'test-model', baseUrl: `http://127.0.0.1:${providerAddress.port}/v1` })).status, 200);
  assert.equal((await post(`/api/sessions/${sessionId}/agent`, { agentId: 'local-api' })).status, 200);

  assert.equal((await post(`/api/sessions/${sessionId}/messages`, { requestId: 'deny-create', text: 'Create denied.txt' })).status, 202);
  let approval = await waitFor(() => session().pendingApprovals[0]);
  assert.equal(session().status, 'awaiting_approval');
  assert.equal(approval.method, 'item/fileChange/requestApproval');
  assert.match(approval.description, /denied.txt/);
  assert.equal(existsSync(join(workspace, 'denied.txt')), false);
  assert.equal((await post(`/api/sessions/${sessionId}/approvals/${approval.id}`, { decision: 'decline' })).status, 200);
  await waitFor(() => session().status === 'idle' ? true : undefined);
  assert.equal(existsSync(join(workspace, 'denied.txt')), false);
  assert.match(providerRequests[1].body.messages.find((message: any) => message.role === 'tool').content, /user declined/);

  assert.equal((await post(`/api/sessions/${sessionId}/messages`, { requestId: 'approve-create', text: 'Create approved.txt' })).status, 202);
  approval = await waitFor(() => session().pendingApprovals[0]);
  assert.equal(existsSync(join(workspace, 'approved.txt')), false);
  assert.equal((await post(`/api/sessions/${sessionId}/approvals/${approval.id}`, { decision: 'allow-always' })).status, 400);
  assert.equal(existsSync(join(workspace, 'approved.txt')), false);
  assert.equal((await post(`/api/sessions/${sessionId}/approvals/${approval.id}`, { decision: 'accept' })).status, 200);
  await waitFor(() => session().status === 'idle' ? true : undefined);
  assert.equal(readFileSync(join(workspace, 'approved.txt'), 'utf8'), 'Contents of approved.txt\n');
  assert.equal(session().messages.at(-1)?.text, 'Created approved.txt.');
  assert.equal(session().pendingApprovals.length, 0);
  assert.ok(providerRequests[0].body.tools.some((tool: any) => tool.function.name === 'workspace_create'));
  assert.ok(providerRequests.every(request => request.authorization === undefined));

  assert.equal((await post(`/api/sessions/${sessionId}/messages`, { requestId: 'cancel-create', text: 'Create cancelled.txt' })).status, 202);
  approval = await waitFor(() => session().pendingApprovals[0]);
  assert.equal((await post(`/api/sessions/${sessionId}/interrupt`, {})).status, 200);
  await waitFor(() => session().status === 'idle' ? true : undefined);
  assert.equal(existsSync(join(workspace, 'cancelled.txt')), false);
  assert.equal(session().pendingApprovals.length, 0);
  assert.equal((await post(`/api/sessions/${sessionId}/approvals/${approval.id}`, { decision: 'accept' })).status, 409);

  assert.equal((await post(`/api/sessions/${sessionId}/messages`, { requestId: 'expired-key', text: 'Continue after the provider key expired' })).status, 202);
  await waitFor(() => session().status === 'failed' ? true : undefined);
  assert.equal(application.state().runtime.authenticated, false);
  assert.match(application.state().runtime.error ?? '', /authentication/);
  assert.equal(JSON.stringify(application.state()).includes('reflected by a failing proxy'), false);
});
