import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function freshProject(page: Page) {
  const registry = await (await page.request.get('/api/projects')).json();
  const workspace = join(dirname(registry.projects[0].workspace), `autoconnect-${randomUUID()}`);
  await mkdir(workspace);
  const added = await page.request.post('/api/projects', { data: { workspace } });
  expect(added.ok()).toBe(true);
  return (await added.json()).path as string;
}
async function state(page: Page, path: string) {
  return (await page.request.get(`${path}api/state`)).json();
}
function expectNoAutomaticTurns(snapshot: any) {
  expect(snapshot.sessions).toHaveLength(1);
  expect(snapshot.sessions[0]).toMatchObject({ status: 'idle', threadId: null, turnId: null, messages: [] });
}

test('a workspace connects automatically once and reuses a ready runtime after reload', async ({ page }) => {
  const path = await freshProject(page);
  let requests = 0;
  let frames = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  page.on('websocket', socket => {
    if (socket.url().endsWith('/api/events')) socket.on('framereceived', frame => {
      if (JSON.parse(String(frame.payload)).type === 'state') frames++;
    });
  });
  await page.route('**/api/runtime/connect', async route => {
    requests++;
    await ready;
    await route.continue();
  });
  try {
    await page.goto(path);
    await expect(page.getByRole('status', { name: 'Connecting to Codex…', exact: true })).toBeVisible();
    await expect(page.getByText('Connecting to Codex with your existing login…', { exact: true })).toBeVisible();
    expect(requests).toBe(1);
    expectNoAutomaticTurns(await state(page, path));
    release();
    await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
    await expect.poll(() => frames).toBe(1);
    const connected = await state(page, path);
    expect(connected.runtime).toMatchObject({ connected: true, authenticated: true });
    expectNoAutomaticTurns(connected);
    await page.reload();
    await expect.poll(() => frames).toBe(2);
    await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
    expect(requests).toBe(1);
    expectNoAutomaticTurns(await state(page, path));
  } finally { release(); }
});

test('a failed automatic connection does not loop on service reconnect and can be retried manually', async ({ page }) => {
  const path = await freshProject(page);
  const sockets: WebSocketRoute[] = [];
  let requests = 0;
  await page.routeWebSocket('**/api/events', socket => { sockets.push(socket); socket.connectToServer(); });
  await page.route('**/api/runtime/connect', async route => {
    requests++;
    if (requests === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Automatic connection test failure.' }) });
    else await route.continue();
  });
  await page.goto(path);
  await expect(page.getByRole('status').filter({ hasText: 'Automatic connection test failure.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry agent connection', exact: true })).toBeEnabled();
  expect(requests).toBe(1);
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Keep this draft while the connection recovers.');
  await sockets[0].close({ code: 1012, reason: 'Integration reconnect check' });
  await expect.poll(() => sockets.length).toBe(2);
  await expect(page.locator('.offline-banner')).toHaveCount(0);
  expect(requests).toBe(1);
  expectNoAutomaticTurns(await state(page, path));
  await page.getByRole('button', { name: 'Retry agent connection', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
  expect(requests).toBe(2);
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toHaveValue('Keep this draft while the connection recovers.');
  expectNoAutomaticTurns(await state(page, path));
});

test('an existing-login check that requires sign-in waits for manual retry and preserves the draft', async ({ page }) => {
  const path = await freshProject(page);
  const baseline = await state(page, path);
  let requests = 0;
  let requiresLogin = false;
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    if (requiresLogin) snapshot.runtime = { ...snapshot.runtime, connected: true, authenticated: false };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route('**/api/runtime/connect', async route => {
    requests++;
    if (requests === 1) {
      requiresLogin = true;
      await route.fulfill({ json: { ...baseline.runtime, connected: true, authenticated: false } });
    } else { requiresLogin = false; await route.continue(); }
  });
  await page.goto(path);
  await expect(page.getByText('Sign in with codex login, then reconnect.', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await input.fill('Keep this draft while I sign in.');
  await expect(page.getByRole('button', { name: 'Send message to Codex', exact: true })).toBeDisabled();
  await page.waitForTimeout(800);
  expect(requests).toBe(1);
  expectNoAutomaticTurns(await state(page, path));
  await page.getByRole('button', { name: 'Retry agent connection', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
  expect(requests).toBe(2);
  await expect(input).toHaveValue('Keep this draft while I sign in.');
  expectNoAutomaticTurns(await state(page, path));
});
