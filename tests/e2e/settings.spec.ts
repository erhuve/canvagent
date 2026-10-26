import { expect, test, type Page } from '@playwright/test';
import { defaultAgentSettings } from '../../src/shared/settings';

async function state(page: Page) { return page.evaluate(async () => (await fetch(new URL('api/state', location.href))).json()); }
async function activeSession(page: Page) {
  const saved = await state(page);
  return saved.sessions.find((session: any) => session.id === saved.activeSessionId);
}
async function newConversation(page: Page) {
  const previous = (await state(page)).activeSessionId;
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect.poll(async () => (await state(page)).activeSessionId).not.toBe(previous);
  return (await state(page)).activeSessionId;
}
async function prepare(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  const reset = await page.request.post(new URL('api/settings', page.url()).href, { data: defaultAgentSettings() });
  expect(reset.ok()).toBe(true);
  await newConversation(page);
  const connect = page.getByRole('button', { name: 'Retry agent connection', exact: true });
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
}
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'More Codex settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex settings', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('common settings live in the composer and preserve an unsent draft', async ({ page }) => {
  await prepare(page);
  const composer = page.locator('.composer .composer-toolbar');
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  const draft = 'Keep this draft while I choose how Codex should work.';
  await input.fill(draft);
  for (const name of ['Approval mode', 'Collaboration mode', 'Agent model', 'Thinking level']) {
    await expect(composer.getByRole('combobox', { name, exact: true })).toBeVisible();
  }
  await expect(composer.getByRole('switch', { name: 'Fast mode', exact: true })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'More Codex settings', exact: true })).toBeVisible();
  await expect(page.locator('.conversation-header .agent-settings-quick')).toHaveCount(0);
  await expect(page.locator('.conversation-header').getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Speed', exact: true })).toHaveCount(0);
  await composer.getByRole('combobox', { name: 'Approval mode', exact: true }).selectOption('auto-review');
  await composer.getByRole('combobox', { name: 'Collaboration mode', exact: true }).selectOption('plan');
  await composer.getByRole('combobox', { name: 'Agent model', exact: true }).selectOption('browser-fixture');
  await composer.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('high');
  await composer.getByRole('switch', { name: 'Fast mode', exact: true }).click();
  await expect.poll(async () => (await activeSession(page)).settings).toMatchObject({ model: 'browser-fixture', reasoningEffort: 'high', serviceTier: 'fast', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxMode: 'workspace-write', collaborationMode: 'plan' });
  await expect(input).toHaveValue(draft);
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('combobox', { name: 'Collaboration mode', exact: true })).toHaveValue('plan');
  await dialog.getByRole('combobox', { name: 'Response verbosity', exact: true }).selectOption('low');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue(draft);
  expect((await activeSession(page))).toMatchObject({ status: 'idle', turnId: null, messages: [] });
  expect((await state(page)).runtime.settings).toMatchObject({ model: 'browser-fixture', reasoningEffort: 'high', serviceTier: 'fast', approvalsReviewer: 'auto_review', collaborationMode: 'plan', verbosity: '' });
});

test('dialog settings belong to each conversation while composer selections seed new conversations', async ({ page }) => {
  await prepare(page);
  const firstId = (await state(page)).activeSessionId;
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  const firstTitle = '[chat] Remember my first conversation settings.';
  await input.fill(firstTitle);
  await input.press('Enter');
  await expect.poll(async () => (await activeSession(page)).status).toBe('idle');
  await page.getByRole('combobox', { name: 'Agent model', exact: true }).selectOption('browser-fixture');
  await page.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('high');
  await page.getByRole('switch', { name: 'Fast mode', exact: true }).click();
  const dialog = await openSettings(page);
  await dialog.getByRole('combobox', { name: 'Approval policy', exact: true }).selectOption('never');
  await dialog.getByRole('combobox', { name: 'Approval reviewer', exact: true }).selectOption('auto_review');
  await dialog.getByRole('combobox', { name: 'Sandbox access', exact: true }).selectOption('read-only');
  await dialog.getByRole('combobox', { name: 'Network access', exact: true }).selectOption('false');
  await dialog.getByRole('combobox', { name: 'Web search', exact: true }).selectOption('cached');
  await dialog.getByRole('combobox', { name: 'Reasoning summaries', exact: true }).selectOption('concise');
  await dialog.getByRole('combobox', { name: 'Response verbosity', exact: true }).selectOption('low');
  await dialog.getByRole('textbox', { name: 'Additional writable roots', exact: false }).fill('/tmp/extra-root\n/tmp/another-root');
  await dialog.getByRole('textbox', { name: 'Additional instructions', exact: false }).fill('Keep responses focused on this project.');
  await dialog.getByRole('textbox', { name: 'Advanced Codex configuration (JSON)', exact: false }).fill('{"model_context_window": 200000}');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await activeSession(page)).settings).toMatchObject({ model: 'browser-fixture', reasoningEffort: 'high', serviceTier: 'fast', approvalPolicy: 'never', approvalsReviewer: 'auto_review', sandboxMode: 'read-only', networkAccess: false, webSearch: 'cached', reasoningSummary: 'concise', verbosity: 'low', writableRoots: ['/tmp/extra-root', '/tmp/another-root'], additionalInstructions: 'Keep responses focused on this project.', configOverrides: { model_context_window: 200000 } });
  const secondId = await newConversation(page);
  expect(secondId).not.toBe(firstId);
  expect((await activeSession(page)).settings).toMatchObject({ model: 'browser-fixture', reasoningEffort: 'high', serviceTier: 'fast', approvalPolicy: 'on-request', sandboxMode: 'workspace-write', additionalInstructions: '', configOverrides: {} });
  await page.getByRole('combobox', { name: 'Agent model', exact: true }).selectOption('browser-light');
  await page.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('low');
  await page.getByRole('button', { name: `Open conversation: ${firstTitle}`, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Thinking level', exact: true })).toHaveValue('high');
  await expect(page.getByRole('switch', { name: 'Fast mode', exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Agent model', exact: true })).toHaveValue('browser-fixture');
  expect((await activeSession(page)).settings.configOverrides).toEqual({ model_context_window: 200000 });
  expect((await state(page)).sessions.find((session: any) => session.id === secondId).settings).toMatchObject({ model: 'browser-light', reasoningEffort: 'low' });
});

test('Auto review and common settings are remembered after reload and in a new conversation', async ({ page }) => {
  await prepare(page);
  const originalId = (await state(page)).activeSessionId;
  const originalSettings = (await activeSession(page)).settings;
  await newConversation(page);
  const dialog = await openSettings(page);
  await dialog.getByRole('textbox', { name: 'Additional instructions', exact: false }).fill('Only this conversation should have this instruction.');
  await dialog.getByRole('textbox', { name: 'Advanced Codex configuration (JSON)', exact: false }).fill('{"model_context_window": 180000}');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Approval mode', exact: true }).selectOption('auto-review');
  await page.getByRole('combobox', { name: 'Agent model', exact: true }).selectOption('browser-fixture');
  await page.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('high');
  await page.getByRole('switch', { name: 'Fast mode', exact: true }).click();
  await page.getByRole('combobox', { name: 'Collaboration mode', exact: true }).selectOption('plan');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveValue('auto-review');
  await newConversation(page);
  await expect(page.getByRole('combobox', { name: 'Approval mode', exact: true })).toHaveValue('auto-review');
  await expect(page.getByRole('combobox', { name: 'Agent model', exact: true })).toHaveValue('browser-fixture');
  await expect(page.getByRole('combobox', { name: 'Thinking level', exact: true })).toHaveValue('high');
  await expect(page.getByRole('switch', { name: 'Fast mode', exact: true })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Collaboration mode', exact: true })).toHaveValue('plan');
  expect((await activeSession(page)).settings).toMatchObject({ additionalInstructions: '', configOverrides: {} });
  expect((await state(page)).sessions.find((session: any) => session.id === originalId).settings).toEqual(originalSettings);
});

test('a working conversation can save settings for its next turn and still run other conversations', async ({ page }) => {
  await prepare(page);
  const firstId = (await state(page)).activeSessionId;
  const title = '[chat] Keep working while I change next-turn settings.';
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await input.fill(title);
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop agent' })).toBeVisible();
  const turnId = (await activeSession(page)).turnId;
  await input.fill('Unsent update while changing the next turn.');
  const composer = page.locator('.composer .composer-toolbar');
  await expect(composer.getByRole('combobox', { name: 'Agent model', exact: true })).toBeEnabled();
  await composer.getByRole('combobox', { name: 'Agent model', exact: true }).selectOption('browser-light');
  await composer.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('low');
  await composer.getByRole('combobox', { name: 'Collaboration mode', exact: true }).selectOption('plan');
  await expect(input).toHaveValue('Unsent update while changing the next turn.');
  expect((await activeSession(page))).toMatchObject({ turnId, status: 'running' });
  expect((await activeSession(page)).messages.filter((message: any) => message.role === 'user')).toHaveLength(1);
  const dialog = await openSettings(page);
  await expect(dialog).toContainText('The current turn keeps its settings.');
  await expect(dialog.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('browser-light');
  await expect(dialog.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue('low');
  await expect(dialog.getByRole('combobox', { name: 'Collaboration mode', exact: true })).toHaveValue('plan');
  await dialog.getByRole('textbox', { name: 'Additional instructions', exact: false }).fill('Plan the next turn before editing.');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await activeSession(page))).toMatchObject({ turnId, status: 'running', settings: { model: 'browser-light', reasoningEffort: 'low', collaborationMode: 'plan', additionalInstructions: 'Plan the next turn before editing.' } });
  const secondId = await newConversation(page);
  await input.fill('[chat] Keep working in a second conversation.');
  await input.press('Enter');
  await expect.poll(async () => (await state(page)).sessions.filter((session: any) => [firstId, secondId].includes(session.id)).map((session: any) => session.status)).toEqual(['running', 'running']);
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await page.getByRole('button', { name: `Open conversation: ${title}`, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Agent model', exact: true })).toHaveValue('browser-light');
  await expect(page.getByRole('combobox', { name: 'Collaboration mode', exact: true })).toHaveValue('plan');
  await expect(input).toHaveValue('Unsent update while changing the next turn.');
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await input.fill('[chat] Use the saved next-turn settings.');
  await input.press('Enter');
  await expect.poll(async () => (await activeSession(page)).status).toBe('idle');
  expect((await activeSession(page)).settings.collaborationMode).toBe('plan');
});

test('malformed advanced configuration keeps every form edit available to repair', async ({ page }) => {
  await prepare(page);
  const before = (await activeSession(page)).settings;
  const dialog = await openSettings(page);
  await dialog.getByRole('textbox', { name: 'Additional instructions', exact: false }).fill('Do not lose this unsaved instruction.');
  const json = dialog.getByRole('textbox', { name: 'Advanced Codex configuration (JSON)', exact: false });
  await json.fill('{"broken":');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Advanced configuration is invalid');
  await expect(json).toBeFocused();
  await expect(json).toHaveValue('{"broken":');
  await expect(dialog.getByRole('textbox', { name: 'Additional instructions', exact: false })).toHaveValue('Do not lose this unsaved instruction.');
  expect((await activeSession(page)).settings).toEqual(before);
  await json.fill('{"model_context_window": 180000}');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await activeSession(page)).settings).toMatchObject({ additionalInstructions: 'Do not lose this unsaved instruction.', configOverrides: { model_context_window: 180000 } });
});

test('model switching uses the advertised thinking and speed catalogs', async ({ page }) => {
  await prepare(page);
  const model = page.getByRole('combobox', { name: 'Agent model', exact: true });
  const effort = page.getByRole('combobox', { name: 'Thinking level', exact: true });
  const fast = page.getByRole('switch', { name: 'Fast mode', exact: true });
  await model.selectOption('browser-fixture');
  await effort.selectOption('high');
  await expect(fast).toBeEnabled();
  await fast.click();
  await expect(fast).toBeChecked();
  await model.selectOption('browser-light');
  await expect(effort).toHaveValue('');
  await expect(fast).not.toBeChecked();
  await expect(fast).toBeDisabled();
  await expect(effort.locator('option[value=high]')).toHaveCount(0);
  await expect(effort.locator('option[value=low]')).toHaveCount(1);
  await model.selectOption('browser-fixture');
  await expect(fast).toBeEnabled();
  const customModel = 'custom-local-model';
  const id = (await state(page)).activeSessionId;
  const saved = await page.request.post(new URL(`api/sessions/${id}/settings`, page.url()).href, { data: { model: customModel } });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await expect(model).toHaveValue(customModel);
  await expect(model.locator(`option[value=${customModel}]`)).toHaveText(customModel);
});

test('turning Fast mode off explicitly overrides inherited fast configuration', async ({ page }) => {
  await prepare(page);
  const dialog = await openSettings(page);
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).selectOption('browser-fixture');
  await dialog.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('');
  await dialog.getByRole('textbox', { name: 'Advanced Codex configuration (JSON)', exact: false }).fill('{"service_tier": "fast"}');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const fast = page.getByRole('switch', { name: 'Fast mode', exact: true });
  await expect(fast).toBeChecked();
  await fast.click();
  await expect(fast).not.toBeChecked();
  await expect.poll(async () => (await activeSession(page)).settings).toMatchObject({ serviceTier: 'default', configOverrides: { service_tier: 'fast' } });
  await page.reload();
  await expect(fast).not.toBeChecked();
  const saved = await openSettings(page);
  await expect(saved.getByRole('combobox', { name: 'Speed', exact: true })).toHaveValue('default');
});

test('remembered thinking and speed retain the model selected through advanced configuration', async ({ page }) => {
  await prepare(page);
  const dialog = await openSettings(page);
  await dialog.getByRole('textbox', { name: 'Advanced Codex configuration (JSON)', exact: false }).fill('{"model": "browser-light"}');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('low');
  await expect.poll(async () => (await state(page)).runtime.settings).toMatchObject({ model: 'browser-light', reasoningEffort: 'low', configOverrides: {} });
  await newConversation(page);
  await expect(page.getByRole('combobox', { name: 'Agent model', exact: true })).toHaveValue('browser-light');
  await expect(page.getByRole('combobox', { name: 'Thinking level', exact: true })).toHaveValue('low');
  await expect(page.getByRole('switch', { name: 'Fast mode', exact: true })).toBeDisabled();
});

test('saving defaults affects new conversations, and the settings dialog fits mobile and closes with Escape', async ({ page }) => {
  await prepare(page);
  const original = (await state(page)).runtime.settings;
  const firstId = (await state(page)).activeSessionId;
  const firstSettings = (await activeSession(page)).settings;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openSettings(page);
    await dialog.getByRole('combobox', { name: 'Model', exact: true }).selectOption('browser-light');
    await dialog.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('low');
    await dialog.getByRole('button', { name: 'Save as defaults', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Defaults saved for new conversations.');
    expect((await activeSession(page)).settings).toEqual(firstSettings);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bounds = await dialog.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More Codex settings', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Open conversation history', exact: true }).click();
    const nextId = await newConversation(page);
    expect(nextId).not.toBe(firstId);
    await expect(page.getByRole('combobox', { name: 'Agent model', exact: true })).toHaveValue('browser-light');
    await expect(page.getByRole('combobox', { name: 'Thinking level', exact: true })).toHaveValue('low');
  } finally {
    const restored = await page.request.post(new URL('api/settings', page.url()).href, { data: original });
    expect(restored.ok()).toBe(true);
  }
});
