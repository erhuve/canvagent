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
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  const initial = await state(page);
  const existing = initial.board.elements.filter((element: any) => !element.isDeleted);
  if (existing.length) await page.evaluate(async ({ revision, operations }) => {
    const response = await fetch('/api/board/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), observedBoardRevision: revision, operations }) });
    if (!response.ok) throw new Error('Could not prepare an empty fixture board.');
  }, { revision: initial.board.revision, operations: existing.map((element: any) => ({ kind: 'delete', elementId: element.id, expectedRevision: initial.board.metadata[element.id].revision })) });
  if (initial.sessions.some((session: any) => session.messages.length)) await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Think it through. Build it together.' })).toBeVisible();
  await drawRectangle(page, 290, 190);
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle').length).toBe(1);
  const first = await state(page);
  const originalId = first.board.elements.find((element: any) => !element.isDeleted && element.type === 'rectangle').id;
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect.poll(async () => (await state(page)).board.elements.some((element: any) => element.id === originalId && !element.isDeleted)).toBe(true);
  // Moving a saved object catches accidental aliasing between Excalidraw and canonical state.
  const surface = page.locator('.excalidraw canvas.interactive').first();
  await expect(surface).toBeVisible();
  const surfaceBounds = (await surface.boundingBox())!;
  const savedRectangle = (await state(page)).board.elements.find((element: any) => element.id === originalId);
  await page.keyboard.press('v');
  const moveStart = { x: surfaceBounds.x + savedRectangle.x + savedRectangle.width * .3, y: surfaceBounds.y + savedRectangle.y + 1 };
  // An unfilled rectangle is hit on its stroke; avoid the corner/midpoint resize handles.
  await page.mouse.click(moveStart.x, moveStart.y);
  await expect(page.locator('.selection-chip')).toContainText('1 object selected');
  await page.mouse.move(moveStart.x, moveStart.y);
  await page.mouse.down();
  await page.mouse.move(moveStart.x + 42, moveStart.y + 27, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).board.elements.find((element: any) => element.id === originalId).x).not.toBe(savedRectangle.x);
  expect((await state(page)).board.elements.find((element: any) => element.id === originalId).width).toBe(savedRectangle.width);
  const connect = page.getByRole('button', { name: 'Connect Codex', exact: true });
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByRole('button', { name: 'Codex connected', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Inspect this sketch and add an editable note. Keep working while I draw.');
  await page.getByRole('button', { name: 'Send message to Codex' }).click();
  await expect(page.getByText(/I inspected the saved board/)).toBeVisible();
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.text === 'An editable note from Codex').length).toBe(1);
  const annotated = await state(page);
  // Editor normalization must not echo the agent's edit as a new human change.
  await page.waitForTimeout(1400);
  expect((await state(page)).board.revision).toBe(annotated.board.revision);
  const settled = await state(page);
  expect(settled.sessions.find((entry: any) => entry.id === settled.activeSessionId).activities.filter((activity: any) => activity.title.startsWith('Canvas revision'))).toHaveLength(0);
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

  await page.reload();
  await expect(page.getByRole('button', { name: 'Undo agent edit' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo agent edit' }).click();
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.text === 'An editable note from Codex').length).toBe(0);
  expect((await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle')).toHaveLength(2);
  await page.reload();
  await expect(page.getByText(/I inspected the saved board/)).toBeVisible();
  expect((await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle')).toHaveLength(2);
  // A pending human drag and incoming agent annotation must survive together.
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('[race] Add a note while I draw. Keep working.');
  await page.getByRole('button', { name: 'Send message to Codex' }).click();
  await expect(page.getByText('Race fixture ready: draw now while I prepare an annotation.')).toBeVisible();
  const beforeRace = await state(page);
  const raceBounds = (await page.locator('.excalidraw canvas.interactive').first().boundingBox())!;
  await page.mouse.click(raceBounds.x + 490, raceBounds.y + 290);
  await page.keyboard.press('r');
  await page.mouse.move(raceBounds.x + 520, raceBounds.y + 320);
  await page.mouse.down();
  let noteArrived = false;
  for (let step = 0; step < 30; step++) {
    await page.mouse.move(raceBounds.x + 550 + step * 2, raceBounds.y + 340 + step);
    await page.waitForTimeout(100);
    const snapshot = await state(page);
    if (snapshot.board.elements.some((element: any) => !element.isDeleted && element.text === 'An editable note from Codex')) { noteArrived = true; break; }
  }
  expect(noteArrived).toBe(true);
  await page.mouse.move(raceBounds.x + 670, raceBounds.y + 420, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('v');
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle').length).toBe(3);
  const afterRace = await state(page);
  const newRectangle = afterRace.board.elements.find((element: any) => !element.isDeleted && element.type === 'rectangle' && !beforeRace.board.elements.some((prior: any) => prior.id === element.id));
  expect(newRectangle.width).toBeGreaterThan(140);
  expect(newRectangle.height).toBeGreaterThan(90);
  expect(afterRace.board.elements.filter((element: any) => !element.isDeleted && element.text === 'An editable note from Codex')).toHaveLength(1);
  await expect(page.locator('.context-notice')).toContainText('shared with agent');
  await page.getByRole('button', { name: 'Stop agent' }).click();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo agent edit' }).click();
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.text === 'An editable note from Codex').length).toBe(0);
  expect((await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'rectangle')).toHaveLength(3);
  expect(errors).toEqual([]);
});
