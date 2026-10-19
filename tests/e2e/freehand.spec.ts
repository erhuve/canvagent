import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function state(page: Page) { return page.evaluate(async () => (await fetch('/api/state')).json()); }

test('agent freehand strokes render as ink, remain editable as a group, and survive export and reload', async ({ page }) => {
  const errors: string[] = [];
  const captures: any[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/capture-result') captures.push(request.postDataJSON()); });
  await page.goto('/');
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  const initial = await state(page);
  const live = initial.board.elements.filter((element: any) => !element.isDeleted);
  if (live.length) await page.evaluate(async ({ revision, operations }) => {
    const response = await fetch('/api/board/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), observedBoardRevision: revision, operations }) });
    if (!response.ok) throw new Error('Could not clear the test canvas.');
  }, { revision: initial.board.revision, operations: live.map((element: any) => ({ kind: 'delete', elementId: element.id, expectedRevision: initial.board.metadata[element.id].revision })) });
  const previousSession = (await state(page)).activeSessionId;
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect.poll(async () => (await state(page)).activeSessionId).not.toBe(previousSession);
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
  const connect = page.getByRole('button', { name: 'Connect Codex', exact: true });
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByRole('button', { name: 'Codex connected', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('[freehand] Draw arbitrary strokes and paths.');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect(page.getByText('Freehand strokes and custom paths are on the canvas.', { exact: true })).toBeVisible();
  expect(captures).toHaveLength(1);
  expect(captures[0].error).toBeUndefined();
  expect(captures[0].dataURL).toMatch(/^data:image\/png;base64,/);
  const pixels = await page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let pink = 0, green = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 120 && pixels[i + 1] < 110 && pixels[i + 2] > 60 && pixels[i + 2] < 180) pink++;
      if (pixels[i] < 90 && pixels[i + 1] > 75 && pixels[i + 1] < 150 && pixels[i + 2] > 60 && pixels[i + 2] < 140) green++;
    }
    return { pink, green };
  }, captures[0].dataURL);
  expect(pixels.pink).toBeGreaterThan(500);
  expect(pixels.green).toBeGreaterThan(100);
  await writeFile('test-results/freehand-capture.png', Buffer.from(captures[0].dataURL.split(',')[1], 'base64'));
  await page.screenshot({ path: 'test-results/freehand-canvas.png' });
  const drawn = await state(page);
  const strokes = drawn.board.elements.filter((element: any) => !element.isDeleted && element.type === 'freedraw');
  expect(strokes).toHaveLength(2);
  const ribbon = strokes.find((element: any) => element.id.startsWith('ribbon-'));
  // A native group must be selectable and movable by the user, without baking
  // the drawing into an image or changing its sampled stroke geometry.
  const surface = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.click(surface.x + ribbon.x, surface.y + ribbon.y);
  await page.keyboard.press('v');
  await page.mouse.click(surface.x + ribbon.x, surface.y + ribbon.y);
  await expect(page.locator('.selection-chip')).toContainText('2 objects selected');
  await page.mouse.move(surface.x + ribbon.x, surface.y + ribbon.y);
  await page.mouse.down();
  await page.mouse.move(surface.x + ribbon.x + 42, surface.y + ribbon.y + 27, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).board.elements.find((element: any) => element.id === ribbon.id).x).toBe(ribbon.x + 42);
  const moved = await state(page);
  for (const stroke of strokes) {
    const current = moved.board.elements.find((element: any) => element.id === stroke.id);
    expect(current.x).toBe(stroke.x + 42);
    expect(current.y).toBe(stroke.y + 27);
    expect(current.points).toEqual(stroke.points);
    expect(current.pressures).toEqual(stroke.pressures);
    expect(current.groupIds).toEqual(stroke.groupIds);
  }
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const scene = JSON.parse(await readFile((await (await downloadEvent).path())!, 'utf8'));
  expect(scene.elements.filter((element: any) => element.type === 'freedraw')).toHaveLength(2);
  expect(scene.elements.find((element: any) => element.id === ribbon.id).points).toEqual(ribbon.points);
  await page.reload();
  await expect(page.getByText('Freehand strokes and custom paths are on the canvas.', { exact: true })).toBeVisible();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  const restored = (await state(page)).board.elements.find((element: any) => element.id === ribbon.id);
  expect(restored.points).toEqual(ribbon.points);
  expect(restored.x).toBe(ribbon.x + 42);
  expect(errors).toEqual([]);
});
