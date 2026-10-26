import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function freshProject(page: Page) {
  const registry = await (await page.request.get('/api/projects')).json();
  const workspace = join(dirname(registry.projects[0].workspace), `agents-${randomUUID()}`);
  await mkdir(workspace);
  const added = await page.request.post('/api/projects', { data: { workspace } });
  expect(added.ok()).toBe(true);
  const path = (await added.json()).path as string;
  await page.goto(path);
  await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
  return path;
}
async function state(page: Page) { return (await page.request.get(new URL('api/state', page.url()).href)).json(); }
async function manageAgents(page: Page, name = 'Codex') {
  await page.getByRole('button', { name: `Choose agent: ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage agents', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Your agents', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function chooseAgent(page: Page, name: string, current = 'Codex') {
  await page.getByRole('button', { name: `Choose agent: ${current}`, exact: true }).click();
  await page.getByRole('menuitemradio').filter({ hasText: name }).click();
  await expect(page.getByRole('button', { name: `Choose agent: ${name}`, exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: `${name} connected`, exact: true })).toBeVisible();
}

test('the composer chooses harnesses, keeps saved conversations, and gates unsupported controls', async ({ page }) => {
  await freshProject(page);
  await expect(page.locator('.app-header').getByRole('button', { name: /Connect Codex|Codex connected/ })).toHaveCount(0);
  const original = (await state(page)).activeSessionId;
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('[chat] Keep this Codex conversation.');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect.poll(async () => (await state(page)).sessions.find((session: any) => session.id === original).status).toBe('idle');
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill('Keep this draft with my Codex conversation.');
  await page.getByRole('button', { name: 'Choose agent: Codex', exact: true }).click();
  await expect(page.getByText('Choosing another agent starts a new conversation. This conversation stays in your history.', { exact: true })).toBeVisible();
  for (const name of ['Claude Code', 'OpenCode', 'Gemini CLI']) await expect(page.getByRole('menuitemradio').filter({ hasText: name })).toBeVisible();
  await page.getByRole('menuitemradio').filter({ hasText: 'Claude Code' }).click();
  await expect(page.getByRole('status', { name: 'Claude Code connected', exact: true })).toBeVisible();
  const selected = await state(page);
  expect(selected.activeSessionId).not.toBe(original);
  expect(selected.sessions.find((session: any) => session.id === original)).toMatchObject({ agentId: 'codex', messages: expect.any(Array) });
  expect(selected.sessions.find((session: any) => session.id === selected.activeSessionId)).toMatchObject({ agentId: 'claude', messages: [] });
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More Codex settings', exact: true })).toHaveCount(0);
  await expect(page.getByText('Models and permissions follow your harness configuration.', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message Claude Code', exact: true });
  await expect(input).toHaveValue('');
  await input.fill('[chat] Keep working while I draft.');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop agent', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose agent: Claude Code', exact: true })).toBeDisabled();
  await expect(page.locator('.message-byline strong')).toHaveText('Claude Code');
  await input.fill('Save this next message until you finish.');
  await expect(page.getByRole('button', { name: 'Queue message to Claude Code', exact: true })).toBeEnabled();
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.getByText('Message queued for the next turn.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
  await page.getByRole('button', { name: 'Open conversation: [chat] Keep this Codex conversation.', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose agent: Codex', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Codex', exact: true })).toHaveValue('Keep this draft with my Codex conversation.');
  expect((await state(page)).activeSessionId).toBe(original);
});

test('custom ACP configuration validates arguments, persists, and can be removed', async ({ page }) => {
  await freshProject(page);
  const dialog = await manageAgents(page);
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Local ACP');
  await dialog.getByRole('textbox', { name: /^Executable/ }).fill('local-agent');
  await dialog.getByRole('textbox', { name: /^Arguments \(JSON\)/ }).fill('acp');
  await dialog.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Arguments must be a JSON array of strings');
  await dialog.getByRole('textbox', { name: /^Arguments \(JSON\)/ }).fill('["acp", "--workspace", "a folder with spaces"]');
  await dialog.getByRole('textbox', { name: /^Environment mapping/ }).fill('{"TOKEN":"MY_AGENT_TOKEN"}');
  await dialog.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Local ACP saved.');
  let configured = (await state(page)).agents.find((agent: any) => agent.name === 'Local ACP');
  expect(configured).toMatchObject({ kind: 'acp', command: 'local-agent', args: ['acp', '--workspace', 'a folder with spaces'], env: { TOKEN: 'MY_AGENT_TOKEN' } });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose agent: Codex', exact: true })).toBeFocused();
  await page.reload();
  await chooseAgent(page, 'Local ACP');
  const reopened = await manageAgents(page, 'Local ACP');
  await reopened.getByRole('button', { name: 'Configure Local ACP', exact: true }).click();
  await expect(reopened.getByRole('textbox', { name: /^Arguments \(JSON\)/ })).toHaveValue('["acp","--workspace","a folder with spaces"]');
  await reopened.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await expect(reopened.getByRole('status')).toHaveText('Local ACP removed.');
  configured = (await state(page)).agents.find((agent: any) => agent.name === 'Local ACP');
  expect(configured).toBeUndefined();
});

test('API credentials stay out of public state and browser storage and can be updated or cleared', async ({ page }) => {
  await freshProject(page);
  const secret = `test-only-key-${randomUUID()}`;
  const dialog = await manageAgents(page);
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('My API');
  await dialog.getByRole('combobox', { name: 'Connection', exact: true }).selectOption('openai-compatible');
  await dialog.getByRole('textbox', { name: 'Model ID', exact: true }).fill('local-model');
  await dialog.getByRole('textbox', { name: /^Base URL/ }).fill('http://localhost:8080/v1');
  await dialog.locator('input[type="password"]').fill(secret);
  await dialog.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('My API saved.');
  const configured = (await state(page)).agents.find((agent: any) => agent.name === 'My API');
  expect(configured).toMatchObject({ kind: 'openai-compatible', model: 'local-model', baseUrl: 'http://localhost:8080/v1', credentialConfigured: true });
  expect(JSON.stringify(await state(page))).not.toContain(secret);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret);
  await expect(dialog.locator('input[type="password"]')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Configure My API', exact: true }).click();
  await expect(dialog.locator('input[type="password"]')).toHaveValue('');
  await expect(dialog.getByText('Pasted keys stay in server memory until it restarts.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Clear session key', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect.poll(async () => (await state(page)).agents.find((agent: any) => agent.id === configured.id).credentialConfigured).toBe(false);
  await dialog.locator('input[type="password"]').fill(`${secret}-replacement`);
  await dialog.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect.poll(async () => (await state(page)).agents.find((agent: any) => agent.id === configured.id).credentialConfigured).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Save agent', exact: true })).toBeEnabled();
  await dialog.getByRole('textbox', { name: /^API key environment variable/ }).fill('MY_PROVIDER_KEY');
  await dialog.locator('input[type="password"]').fill('unsaved-key-for-the-previous-host');
  await dialog.getByRole('textbox', { name: /^Base URL/ }).fill('http://localhost:9090/v1');
  await expect(dialog.getByRole('textbox', { name: /^API key environment variable/ })).toHaveValue('');
  await expect(dialog.locator('input[type="password"]')).toHaveValue('');
  await expect(dialog.getByText('The API endpoint changed.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect.poll(async () => (await state(page)).agents.find((agent: any) => agent.id === configured.id).credentialConfigured).toBe(false);
  await expect(dialog.getByRole('button', { name: 'Save agent', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await chooseAgent(page, 'My API');
  await expect(page.getByRole('textbox', { name: 'Message My API', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Fast mode', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveCount(0);
  await expect(page.locator('.composer-provider-settings')).toHaveText('local-model');
});

test('the agent manager fits mobile and preserves configuration after an invalid environment mapping', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freshProject(page);
  const dialog = await manageAgents(page);
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Mobile agent');
  await dialog.getByRole('textbox', { name: /^Executable/ }).fill('mobile-agent');
  await dialog.getByRole('textbox', { name: /^Environment mapping/ }).fill('{"TOKEN":"a pasted token with spaces"}');
  await dialog.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Environment mapping must use variable names');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Mobile agent');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose agent: Codex', exact: true })).toBeFocused();
});
