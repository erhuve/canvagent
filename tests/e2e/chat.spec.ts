import { expect, test, type Page } from '@playwright/test';

async function state(page: Page) { return page.evaluate(async () => (await fetch('/api/state')).json()); }

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
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Open conversation history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
  await newConversation(page);
  await expect(page.getByRole('button', { name: 'Close conversation history', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
