import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

const defaults = { sidebarWidth: 240, chatRatio: .85 / 2.35 };
type Project = { id: string; name: string };

async function projects(page: Page): Promise<Project[]> {
  return (await (await page.request.get('/api/projects')).json()).projects;
}

async function settings(page: Page) {
  return (await (await page.request.get(new URL('api/layout/settings', page.url()).href)).json()) as typeof defaults;
}

async function width(locator: Locator) { return (await locator.boundingBox())!.width; }

async function drag(page: Page, handle: Locator, delta: number, beforeRelease?: () => Promise<void>) {
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(100, bounds.height / 2));
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + delta, bounds.y + Math.min(100, bounds.height / 2), { steps: 10 });
  await beforeRelease?.();
  await page.mouse.up();
}

async function resetProjects(page: Page) {
  for (const project of await projects(page)) {
    await page.request.get(`/projects/${project.id}/api/state`);
    expect((await page.request.post(`/projects/${project.id}/api/layout/settings`, { data: defaults })).ok()).toBe(true);
  }
}

test.beforeEach(async ({ page }) => resetProjects(page));
test.afterEach(async ({ page }) => resetProjects(page));

test('pane dragging saves on release and restores each project layout after reload', async ({ page }) => {
  const saved: typeof defaults[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/layout/settings')) saved.push(request.postDataJSON());
  });
  await page.addInitScript(() => {
    (window as any).layoutResizeEvents = [];
    window.addEventListener('canvagent:layout-resize', event => (window as any).layoutResizeEvents.push((event as CustomEvent).detail.active));
  });
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: 'Conversation history', exact: true });
  const chat = page.getByRole('region', { name: 'Agent conversation', exact: true });
  const sidebarHandle = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
  const chatHandle = page.getByRole('separator', { name: 'Resize chat and workspace', exact: true });
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await drag(page, sidebarHandle, 100, async () => {
    await expect(page.locator('.app-shell')).toHaveClass(/layout-resize-active/);
    await expect(page.locator('.layout-resize-shield')).toBeVisible();
    await expect.poll(() => width(sidebar)).toBeCloseTo(340, 0);
    await page.waitForTimeout(400);
    expect(saved).toHaveLength(0);
  });
  await expect(page.locator('.layout-resize-shield')).toHaveCount(0);
  await expect.poll(async () => (await settings(page)).sidebarWidth).toBe(340);
  expect(await page.evaluate(() => (window as any).layoutResizeEvents)).toEqual([true, false]);
  const previousChat = await width(chat);
  await drag(page, chatHandle, 90);
  await expect.poll(() => width(chat)).toBeCloseTo(previousChat + 90, 0);
  await expect.poll(async () => (await settings(page)).chatRatio).toBeGreaterThan(defaults.chatRatio);
  const preferred = await settings(page);
  const desiredChat = await width(chat);
  await page.reload();
  await expect.poll(() => width(sidebar)).toBeCloseTo(340, 0);
  await expect.poll(() => width(chat)).toBeCloseTo(desiredChat, 0);
  await page.getByRole('button', { name: 'Open project: second-workspace', exact: true }).click();
  await expect.poll(() => width(sidebar)).toBeCloseTo(240, 0);
  expect(await settings(page)).toEqual(defaults);
  await page.getByRole('button', { name: 'Open project: browser-workspace', exact: true }).click();
  await expect.poll(() => width(sidebar)).toBeCloseTo(340, 0);
  expect(await settings(page)).toEqual(preferred);
});

test('keyboard resizing respects limits, compact layouts preserve preferences and double-click resets', async ({ page }) => {
  await page.goto('/');
  const sidebarHandle = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
  const chatHandle = page.getByRole('separator', { name: 'Resize chat and workspace', exact: true });
  const chat = page.getByRole('region', { name: 'Agent conversation', exact: true });
  await expect(sidebarHandle).toBeVisible();
  await sidebarHandle.press('End');
  await expect(sidebarHandle).toHaveAttribute('aria-valuenow', '420');
  await sidebarHandle.press('Home');
  await expect(sidebarHandle).toHaveAttribute('aria-valuenow', '180');
  await sidebarHandle.press('ArrowRight');
  await sidebarHandle.press('Shift+ArrowRight');
  await expect(sidebarHandle).toHaveAttribute('aria-valuenow', '230');
  await chatHandle.press('Home');
  await expect.poll(() => width(chat)).toBeCloseTo(320, 0);
  await chatHandle.press('End');
  await expect.poll(() => width(page.locator('.right-panel'))).toBeCloseTo(320, 0);
  await expect.poll(async () => (await settings(page)).sidebarWidth).toBe(230);
  const preferred = await settings(page);
  const wideChat = await width(chat);
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect(sidebarHandle).toBeHidden();
  await expect(chatHandle).toBeVisible();
  await expect.poll(() => width(chat)).toBeCloseTo(474, 0);
  expect(await width(page.locator('.right-panel'))).toBeGreaterThanOrEqual(319.9);
  expect(await settings(page)).toEqual(preferred);
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(chatHandle).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Workspace view', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open conversation history', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Conversation history', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => width(chat)).toBeCloseTo(wideChat, 0);
  await sidebarHandle.dblclick();
  await chatHandle.dblclick();
  await expect.poll(() => settings(page)).toEqual(defaults);
  await expect(sidebarHandle).toHaveAttribute('aria-valuenow', '240');
});
