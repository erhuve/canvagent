import { expect, test, type Page } from '@playwright/test';
import type { AppNotification } from '../../src/shared/notifications.js';

type Project = { id: string; name: string };

async function notifications(page: Page): Promise<AppNotification[]> {
  const response = await page.request.get('/api/notifications');
  expect(response.ok()).toBe(true);
  return (await response.json()).notifications;
}

async function state(page: Page, projectId?: string) {
  const url = projectId ? `/projects/${projectId}/api/state` : new URL('api/state', page.url()).href;
  return (await (await page.request.get(url)).json());
}

async function newConversation(page: Page) {
  const previous = (await state(page)).activeSessionId;
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  const previousCount = await page.locator('.thread-list-item').count();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect.poll(async () => (await state(page)).activeSessionId).not.toBe(previous);
  await expect(page.locator('.thread-list-item')).toHaveCount(previousCount + 1);
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toBeEnabled();
  return (await state(page)).activeSessionId as string;
}

async function connect(page: Page) {
  const button = page.getByRole('button', { name: 'Connect Codex', exact: true });
  if (await button.isVisible()) await button.click();
  await expect(page.getByRole('button', { name: 'Codex connected', exact: true })).toBeVisible();
}

async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await input.fill(text);
  await input.press('Enter');
}

async function notificationFor(page: Page, sessionId: string, kind: AppNotification['kind']) {
  await expect.poll(async () => (await notifications(page)).some(entry => entry.sessionId === sessionId && entry.kind === kind)).toBe(true);
  return (await notifications(page)).find(entry => entry.sessionId === sessionId && entry.kind === kind)!;
}

async function openNotifications(page: Page) {
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Notifications', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function notificationRow(page: Page, notification: AppNotification) {
  return page.getByRole('button', { name: `Open notification: ${notification.title} — ${notification.sessionTitle}`, exact: true });
}

test.beforeEach(async ({ page }) => {
  const saved = await notifications(page);
  expect((await page.request.post('/api/notifications/read', { data: { ids: saved.filter(entry => !entry.readAt).map(entry => entry.id) } })).ok()).toBe(true);
  expect((await page.request.post('/api/notification-settings', { data: { systemEnabled: false } })).ok()).toBe(true);
});

test('completed and failed turns persist in the inbox, and opening or marking them read clears the badge', async ({ page }) => {
  await page.goto('/');
  const completedSessionId = await newConversation(page);
  await connect(page);
  await send(page, '[chat] Complete this notification check.');
  const completed = await notificationFor(page, completedSessionId, 'completed');
  const bell = page.getByRole('button', { name: 'Notifications', exact: true });
  await expect(bell.getByText('1', { exact: true })).toBeVisible();
  await openNotifications(page);
  await expect(notificationRow(page, completed)).toBeVisible();
  expect(completed.readAt).toBeUndefined();

  await page.reload();
  await expect(bell.getByText('1', { exact: true })).toBeVisible();
  await openNotifications(page);
  await notificationRow(page, completed).click();
  await expect(page.getByRole('dialog', { name: 'Notifications', exact: true })).not.toBeVisible();
  await expect.poll(async () => (await notifications(page)).find(entry => entry.id === completed.id)?.readAt).toBeTruthy();
  await expect(bell.getByText('1', { exact: true })).toHaveCount(0);
  expect((await state(page)).activeSessionId).toBe(completedSessionId);

  const failedSessionId = await newConversation(page);
  await send(page, '[chat-failure] Check a failed turn notification.');
  const failed = await notificationFor(page, failedSessionId, 'failed');
  const dialog = await openNotifications(page);
  await expect(notificationRow(page, failed)).toBeVisible();
  await dialog.getByRole('button', { name: 'Mark all as read', exact: true }).click();
  await expect.poll(async () => (await notifications(page)).filter(entry => !entry.readAt).length).toBe(0);
  await expect(bell.getByText('1', { exact: true })).toHaveCount(0);

  await page.reload();
  await openNotifications(page);
  await expect(notificationRow(page, completed)).toBeVisible();
  await expect(notificationRow(page, failed)).toBeVisible();
  expect((await notifications(page)).find(entry => entry.id === failed.id)?.readAt).toBeTruthy();
});

test('an approval notification returns to its exact background conversation', async ({ page }) => {
  await page.goto('/');
  const approvalSessionId = await newConversation(page);
  await connect(page);
  await send(page, '[chat-approval] Review this background command.');
  const approval = await notificationFor(page, approvalSessionId, 'approval');
  await expect(page.locator('.approval-card').getByText('Allow this test command?', { exact: true })).toBeVisible();
  const otherSessionId = await newConversation(page);
  expect(otherSessionId).not.toBe(approvalSessionId);
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Keep this draft in its conversation');

  await openNotifications(page);
  await notificationRow(page, approval).click();
  await expect.poll(async () => (await state(page)).activeSessionId).toBe(approvalSessionId);
  await expect(page.locator('.approval-card').getByText('Allow this test command?', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toHaveValue('');
  await expect.poll(async () => (await notifications(page)).find(entry => entry.id === approval.id)?.readAt).toBeTruthy();
  await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Agent conversation', exact: true }).getByText('Approval decision: accept.', { exact: true })).toBeVisible();
});

test('the inbox receives a completion from another project and opens that conversation', async ({ page }) => {
  await page.goto('/');
  const projects: Project[] = (await (await page.request.get('/api/projects')).json()).projects;
  const first = projects.find(project => project.name === 'browser-workspace')!;
  const second = projects.find(project => project.name === 'second-workspace')!;
  const backgroundSessionId = await newConversation(page);
  await connect(page);
  await send(page, '[chat] [project-background] Finish the background task.');
  await expect(page.locator('.message-assistant strong').getByText('streamed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Open project: ${second.name}`, exact: true }).click();
  await expect(page).toHaveURL(new URL(`/projects/${second.id}/`, page.url()).href);
  const sourceSessionId = await newConversation(page);
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('A draft for the second project');
  await expect.poll(() => page.evaluate(id => sessionStorage.getItem(`canvagent:draft:${id}`), sourceSessionId)).toBe('A draft for the second project');

  const completed = await notificationFor(page, backgroundSessionId, 'completed');
  expect(completed.projectId).toBe(first.id);
  const dialog = await openNotifications(page);
  await expect(dialog).toContainText(first.name);
  await notificationRow(page, completed).click();
  await expect(page).toHaveURL(new URL(`/projects/${first.id}/`, page.url()).href);
  await expect.poll(async () => (await state(page)).activeSessionId).toBe(backgroundSessionId);
  await expect(page.getByText('Background project reply finished.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: `Open project: ${second.name}`, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toHaveValue('A draft for the second project');
});

test('stopping a turn does not create a completed or failed notification', async ({ page }) => {
  await page.goto('/');
  const sessionId = await newConversation(page);
  await connect(page);
  await send(page, '[chat] Keep working until I stop this turn.');
  await expect(page.locator('.message-assistant pre')).toContainText('const canvas = "shared";');
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await expect.poll(async () => (await state(page)).sessions.find((entry: any) => entry.id === sessionId).status).toBe('idle');
  expect((await notifications(page)).filter(entry => entry.sessionId === sessionId)).toEqual([]);
  await openNotifications(page);
  await expect(page.getByRole('button', { name: /Open notification: .*Keep working until I stop/ })).toHaveCount(0);
});

test('a native alert opens and reads its notification while preserving the source conversation draft', async ({ page }) => {
  await page.goto('/');
  const targetSessionId = await newConversation(page);
  await connect(page);
  await send(page, '[chat] Return through this native notification.');
  const completed = await notificationFor(page, targetSessionId, 'completed');
  const sourceSessionId = await newConversation(page);
  const sourceTitle = '[chat] Preserve this conversation when an alert opens.';
  await send(page, sourceTitle);
  await notificationFor(page, sourceSessionId, 'completed');
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await input.fill('Keep this unsent draft when a native alert opens');
  await openNotifications(page);

  await page.evaluate(notification => {
    window.dispatchEvent(new CustomEvent('canvagent:open-notification', { detail: {
      projectId: notification.projectId, sessionId: notification.sessionId, notificationId: notification.id,
    } }));
  }, completed);
  await expect(page.getByRole('dialog', { name: 'Notifications', exact: true })).not.toBeVisible();
  await expect.poll(async () => (await state(page)).activeSessionId).toBe(targetSessionId);
  await expect.poll(async () => (await notifications(page)).find(entry => entry.id === completed.id)?.readAt).toBeTruthy();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: `Open conversation: ${sourceTitle}`, exact: true }).click();
  await expect.poll(async () => (await state(page)).activeSessionId).toBe(sourceSessionId);
  await expect(input).toHaveValue('Keep this unsent draft when a native alert opens');
});

test('system alerts request permission only after opt-in and notify while the window is unfocused', async ({ page }) => {
  await page.addInitScript(() => {
    const fixture = { requests: 0, focused: true, shown: [] as { title: string; body?: string }[] };
    (window as any).__notificationTest = fixture;
    class TestNotification extends EventTarget {
      static permission: NotificationPermission = 'default';
      static async requestPermission(): Promise<NotificationPermission> {
        fixture.requests++;
        TestNotification.permission = 'granted';
        return 'granted';
      }
      onclick: ((event: Event) => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        super();
        fixture.shown.push({ title, body: options?.body });
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => fixture.focused });
  });
  await page.goto('/');
  const sessionId = await newConversation(page);
  await connect(page);
  await send(page, '[chat] Finish before system notifications are enabled.');
  await notificationFor(page, sessionId, 'completed');
  const dialog = await openNotifications(page);
  const toggle = dialog.getByRole('switch', { name: 'System notifications', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => (window as any).__notificationTest.requests)).toBe(0);
  expect(await page.evaluate(() => (window as any).__notificationTest.shown)).toEqual([]);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as any).__notificationTest.requests)).toBe(1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).__notificationTest.focused = false; });
  const backgroundSessionId = await newConversation(page);
  await send(page, '[chat] Send a system alert for this completed turn.');
  const completed = await notificationFor(page, backgroundSessionId, 'completed');
  await expect.poll(() => page.evaluate(() => (window as any).__notificationTest.shown.length)).toBe(1);
  const shown = await page.evaluate(() => (window as any).__notificationTest.shown);
  expect(shown[0].title).toContain(completed.title);
  expect(shown[0].body).toContain(completed.sessionTitle);

  await openNotifications(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect((await (await page.request.get('/api/notification-settings')).json()).systemEnabled).toBe(false);
});
