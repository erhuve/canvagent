import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function state(page: Page) { return page.evaluate(async () => { const response = await fetch('/api/state'); return response.json(); }); }

async function drawRectangle(page: Page, offsetX: number, offsetY: number) {
  const surface = page.locator('.excalidraw canvas.interactive').first();
  await expect(surface).toBeVisible();
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('Missing drawing surface');
  await page.mouse.click(bounds.x + offsetX - 30, bounds.y + offsetY - 30);
  await page.keyboard.press('r');
  await page.mouse.move(bounds.x + offsetX, bounds.y + offsetY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + offsetX + 135, bounds.y + offsetY + 85, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('v');
}

test('a real drawing, browser capture, agent note, live notice and safe undo share one durable board', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Think it through. Build it together.' })).toBeVisible();
  await drawRectangle(page, 290, 190);
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle').length).toBe(1);
  const first = await state(page);
  const originalId = first.board.elements.find((element: any) => !element.isDeleted && element.type === 'rectangle').id;
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect.poll(async () => (await state(page)).board.elements.some((element: any) => element.id === originalId && !element.isDeleted)).toBe(true);
  await page.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Codex connected', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Inspect this sketch and add an editable note. Keep working while I draw.');
  await page.getByRole('button', { name: 'Send message to Codex' }).click();
  await expect(page.getByText(/I inspected the saved board/)).toBeVisible();
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.text === 'An editable note from Codex').length).toBe(1);
  const annotated = await state(page);
  // Editor normalization must not echo the agent's edit as a new human change.
  await page.waitForTimeout(1400);
  expect((await state(page)).board.revision).toBe(annotated.board.revision);
  expect((await state(page)).sessions[0].activities.filter((activity: any) => activity.title.startsWith('Canvas revision'))).toHaveLength(0);
  await page.screenshot({ path: 'test-results/shared-canvas-annotated.png' });

  await drawRectangle(page, 280, 390);
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle').length).toBe(2);
  await expect(page.locator('.context-notice')).toContainText('shared with agent');
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toHaveCount(0);

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.excalidraw$/);
  const scene = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(scene.type).toBe('excalidraw');
  expect(scene.elements.some((element: any) => element.text === 'An editable note from Codex')).toBe(true);

  await page.getByRole('button', { name: 'Undo agent edit' }).click();
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.text === 'An editable note from Codex').length).toBe(0);
  expect((await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle')).toHaveLength(2);
  await page.reload();
  await expect(page.getByText(/I inspected the saved board/)).toBeVisible();
  expect((await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle')).toHaveLength(2);
  expect(errors).toEqual([]);
});
