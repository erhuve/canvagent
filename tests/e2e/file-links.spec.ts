import { expect, test, type Page } from '@playwright/test';

async function showLinks(page: Page) {
  await page.goto('/');
  const state = async () => (await (await page.request.get(new URL('api/state', page.url()).href)).json());
  const previous = (await state()).activeSessionId;
  if (!await page.getByRole('button', { name: 'New conversation', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Open conversation history', exact: true }).click();
  }
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect.poll(async () => (await state()).activeSessionId).not.toBe(previous);
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toBeEnabled();
  const retry = page.getByRole('button', { name: 'Retry agent connection', exact: true });
  if (await retry.isVisible()) await retry.click();
  await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('[file-links] Show workspace files.');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Relative draft', exact: true })).toBeVisible();
}

test('chat file links open the editor in this window and reveal source locations', async ({ page }) => {
  await showLinks(page);
  const url = page.url();
  for (const [name, path] of [['Relative draft', 'notes/draft.txt'], ['Absolute readme', 'README.md'], ['Source line', 'src/example.ts'], ['File URL', 'README.md']]) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: 'File contents', exact: true })).toBeVisible();
    await expect(page.locator('.file-tab button[role="tab"][aria-selected="true"]')).toHaveAttribute('title', path);
    if (name === 'Source line') await expect(page.locator('.file-editor-footer')).toContainText('Ln 1, Col 7');
  }
  expect(page.url()).toBe(url);
  expect(page.context().pages()).toHaveLength(1);
  await expect(page.getByRole('link', { name: 'Website', exact: true })).toHaveAttribute('target', '_blank');
  await page.getByRole('link', { name: 'Missing file', exact: true }).click();
  await expect(page.locator('.toast')).toBeVisible();
});

test('chat file context menu opens, copies, and supports keyboard dismissal', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).copiedPath = text; } } });
  });
  await showLinks(page);
  const link = page.getByRole('link', { name: 'Relative draft', exact: true });
  await link.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'File link actions: notes/draft.txt', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await menu.getByRole('menuitem', { name: 'Copy relative path', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copiedPath)).toBe('notes/draft.txt');
  await expect(link).toBeFocused();
  await link.press('Shift+F10');
  await expect(menu.getByRole('menuitem', { name: 'Open file', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Copy relative path', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(link).toBeFocused();
  await link.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open file', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File contents', exact: true })).toBeVisible();
});

test('opening a file link on mobile reveals the workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await showLinks(page);
  await page.getByRole('link', { name: 'Relative draft', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'File contents', exact: true })).toBeVisible();
});
