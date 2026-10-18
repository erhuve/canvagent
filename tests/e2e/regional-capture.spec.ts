import { expect, test, type Page } from '@playwright/test';

async function savedState(page: Page) {
  return page.evaluate(async () => (await fetch('/api/state')).json());
}

test('a distant object does not change regional pixels and a huge blank capture stays bounded', async ({ page }) => {
  const captures: { dataURL?: string; bounds?: { width: number; height: number }; error?: string }[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/capture-result' && request.method() === 'POST') captures.push(request.postDataJSON());
  });
  await page.goto('/');
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  const initial = await savedState(page);
  const live = initial.board.elements.filter((element: any) => !element.isDeleted);
  if (live.length) {
    await page.evaluate(async ({ revision, operations }) => {
      const response = await fetch('/api/board/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), observedBoardRevision: revision, operations }) });
      if (!response.ok) throw new Error('Could not prepare an empty fixture board.');
    }, { revision: initial.board.revision, operations: live.map((element: any) => ({ kind: 'delete', elementId: element.id, expectedRevision: initial.board.metadata[element.id].revision })) });
  }
  await page.getByRole('button', { name: 'New conversation' }).click();
  const surface = (await page.locator('.excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.click(surface.x + 260, surface.y + 190);
  await page.keyboard.press('r');
  await page.mouse.move(surface.x + 290, surface.y + 220);
  await page.mouse.down();
  await page.mouse.move(surface.x + 425, surface.y + 305, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press('v');
  await expect.poll(async () => (await savedState(page)).board.elements.filter((element: any) => !element.isDeleted).length).toBe(1);
  const connect = page.getByRole('button', { name: 'Connect Codex', exact: true });
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByRole('button', { name: 'Codex connected', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('[regional-capture] Check the selected region before and after adding a distant object.');
  await page.getByRole('button', { name: 'Send message to Codex' }).click();
  await expect(page.getByText('Regional capture checks complete.')).toBeVisible();
  expect(captures).toHaveLength(3);
  expect(captures.every(capture => !capture.error && capture.dataURL?.startsWith('data:image/png;base64,'))).toBe(true);
  const decoded = await page.evaluate(async urls => {
    return Promise.all(urls.map(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let index = 0; index < pixels.length; index += 4) if (Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 240 && pixels[index + 3]) ink++;
      const digest = await crypto.subtle.digest('SHA-256', pixels);
      return { width: canvas.width, height: canvas.height, ink, hash: Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('') };
    }));
  }, captures.map(capture => capture.dataURL!));
  expect(decoded[0].ink).toBeGreaterThan(100);
  expect(decoded[0].width).toBe(captures[0].bounds!.width);
  expect(decoded[0].height).toBe(captures[0].bounds!.height);
  expect(decoded[1]).toEqual(decoded[0]);
  expect(decoded[2]).toMatchObject({ width: 2048, height: 2048, ink: 0 });
});
