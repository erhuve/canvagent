import { expect, test, type Page } from '@playwright/test';

async function state(page: Page) { return page.evaluate(async () => (await fetch(new URL('api/state', location.href))).json()); }

async function newConversation(page: Page) {
  const previous = (await state(page)).activeSessionId;
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect.poll(async () => (await state(page)).activeSessionId).not.toBe(previous);
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toBeEnabled();
  return (await state(page)).activeSessionId;
}

async function connect(page: Page) {
  const button = page.getByRole('button', { name: 'Connect Codex', exact: true });
  if (await button.isVisible()) await button.click();
  await expect(page.getByRole('button', { name: 'Codex connected', exact: true })).toBeVisible();
}

test('assistant-ui streams markdown, steers the active turn, stops, and switches saved conversations', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const firstId = await newConversation(page);
  await connect(page);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await input.fill('[chat] Keep working while I send an update.');
  await input.press('Control+Enter');
  await expect(page.locator('.message-assistant strong').getByText('streamed', { exact: true })).toBeVisible();
  await expect(page.locator('.message-assistant pre')).toContainText('const canvas = "shared";');
  const active = await state(page);
  const originalTurnId = active.sessions.find((s: any) => s.id === firstId).turnId;
  await input.fill('Update the current task, without starting another turn.');
  await page.getByRole('button', { name: 'Send update to Codex', exact: true }).click();
  await expect(page.getByText('Update received by the active turn.', { exact: true })).toBeVisible();
  const updated = await state(page);
  expect(updated.sessions.find((s: any) => s.id === firstId).turnId).toBe(originalTurnId);
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toHaveCount(0);
  const secondId = await newConversation(page);
  await input.fill('[chat] A separate conversation.');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect.poll(async () => (await state(page)).sessions.find((s: any) => s.id === secondId).status).toBe('idle');
  await page.getByRole('button', { name: 'Open conversation: [chat] Keep working while I send an update.', exact: true }).click();
  await expect(page.getByText('Update received by the active turn.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toHaveValue('');
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Update received by the active turn.', { exact: true })).toBeVisible();
  expect((await state(page)).activeSessionId).toBe(firstId);
  expect(errors).toEqual([]);
});

test('a rejected send restores its draft, and native Codex approval controls still answer once', async ({ page }) => {
  await page.goto('/');
  await newConversation(page);
  await connect(page);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await page.route('**/api/sessions/*/messages', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Test service is unavailable.' }) }));
  await input.fill('[chat-approval] Check the approval controls.');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Test service is unavailable.');
  await expect(input).toHaveValue('[chat-approval] Check the approval controls.');
  await page.unroute('**/api/sessions/*/messages');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect(page.getByText('Allow this test command?', { exact: true })).toBeVisible();
  await expect(page.locator('.approval-card pre')).toContainText('browser approval check');
  await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await expect(page.getByText('Approval decision: accept.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toHaveCount(0);
  const saved = await state(page);
  expect(saved.sessions.find((s: any) => s.id === saved.activeSessionId).pendingApprovals).toEqual([]);
  expect(saved.sessions.find((s: any) => s.id === saved.activeSessionId).status).toBe('idle');
  expect(saved.sessions.find((s: any) => s.id === saved.activeSessionId).messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
});

test('Computer Use permission requests show Approve and recover from a failed submission', async ({ page }) => {
  await page.goto('/');
  await newConversation(page);
  await connect(page);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await input.fill('[computer-use-approval] Show me the website.');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect(page.getByText('Allow Computer Use to use "Google Chrome"?', { exact: true })).toBeVisible();
  await expect(page.getByText('Carefully monitor the app while Computer Use works.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve once', exact: true });
  await page.route('**/api/sessions/*/approvals/*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Approval service unavailable.' }) }));
  await approve.click();
  await expect(page.getByRole('status').filter({ hasText: 'Approval service unavailable.' })).toBeVisible();
  await expect(approve).toBeEnabled();
  const pending = await state(page);
  expect(pending.sessions.find((s: any) => s.id === pending.activeSessionId).status).toBe('awaiting_approval');
  await page.unroute('**/api/sessions/*/approvals/*');
  await approve.click();
  await expect(page.getByText('Approval decision: accept.', { exact: true })).toBeVisible();
  await expect(approve).toHaveCount(0);
  const saved = await state(page);
  expect(saved.sessions.find((s: any) => s.id === saved.activeSessionId).pendingApprovals).toEqual([]);
  expect(saved.sessions.find((s: any) => s.id === saved.activeSessionId).status).toBe('idle');
});

test('mobile navigation keeps the canvas mounted and the conversation drawer usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toBeVisible();
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Open conversation history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
  await newConversation(page);
  await expect(page.getByRole('button', { name: 'Close conversation history', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('running conversations allow navigation, parallel work, separate drafts and independent stops', async ({ page }) => {
  await page.goto('/');
  const firstId = await newConversation(page);
  await connect(page);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  const firstTitle = '[chat] Keep working on the first task.';
  const secondTitle = '[chat] Keep working on the second task.';
  await input.fill(firstTitle);
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop agent' })).toBeVisible();
  await input.fill('Unsent first-thread update');
  const secondId = await newConversation(page);
  await expect(input).toHaveValue('');
  await input.fill(secondTitle);
  await input.press('Enter');
  await expect.poll(async () => (await state(page)).sessions.filter((s: any) => [firstId, secondId].includes(s.id)).map((s: any) => s.status)).toEqual(['running', 'running']);
  await expect(page.locator('.thread-run-status[aria-label="Working"]')).toHaveCount(2);
  await input.fill('Unsent second-thread update');
  await page.getByRole('button', { name: `Open conversation: ${firstTitle}`, exact: true }).click();
  await expect(input).toHaveValue('Unsent first-thread update');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.getByText('Update received by the active turn.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await expect.poll(async () => (await state(page)).sessions.find((s: any) => s.id === firstId).status).toBe('idle');
  expect((await state(page)).sessions.find((s: any) => s.id === secondId).status).toBe('running');
  await page.getByRole('button', { name: `Open conversation: ${secondTitle}`, exact: true }).click();
  await expect(input).toHaveValue('Unsent second-thread update');
  await expect(page.getByText('Update received by the active turn.', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await expect.poll(async () => (await state(page)).sessions.find((s: any) => s.id === secondId).status).toBe('idle');
});

test('a pending send in the background does not lock another composer or restore into its draft', async ({ page }) => {
  await page.goto('/');
  const firstId = await newConversation(page);
  await connect(page);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  const firstTitle = '[chat] Prepare the background conversation.';
  await input.fill(firstTitle);
  await input.press('Enter');
  await expect.poll(async () => (await state(page)).sessions.find((s: any) => s.id === firstId).status).toBe('idle');
  let release: (() => void) | undefined;
  await page.route(`**/api/sessions/${firstId}/messages`, async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Background send failed.' }) });
  });
  await input.fill('Failed background message');
  await input.press('Enter');
  await expect.poll(() => !!release).toBe(true);
  try {
    const secondId = await newConversation(page);
    await input.fill('[chat] A parallel submission.');
    await input.press('Enter');
    await expect.poll(async () => (await state(page)).sessions.find((s: any) => s.id === secondId).messages.some((m: any) => m.role === 'assistant')).toBe(true);
    await input.fill('Second conversation draft');
    release!();
    await expect(page.getByText('Background send failed.', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('Second conversation draft');
    const projectUrl = page.url();
    await page.getByRole('button', { name: 'Open project: second-workspace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open project: second-workspace', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'Open project: browser-workspace', exact: true }).click();
    await expect(page).toHaveURL(projectUrl);
    await expect(input).toHaveValue('Second conversation draft');
    await page.getByRole('button', { name: `Open conversation: ${firstTitle}`, exact: true }).click();
    await expect.poll(async () => (await state(page)).activeSessionId).toBe(firstId);
    await expect(input).toHaveValue('Failed background message');
  } finally { release?.(); }
});
