import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const preview = 'https://canvas-preview.test/';

async function state(page: Page) {
  return page.evaluate(async () => (await fetch(new URL('api/state', location.href))).json());
}

async function openEmptyCanvas(page: Page) {
  await page.route('https://canvas-preview.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><title>Canvas website fixture</title></head>
      <body style="margin:0;background:#fff;font:16px sans-serif;min-height:1200px">
        <h1 style="margin:24px">Live canvas preview</h1>
        <button style="position:absolute;right:32px;top:100px;width:200px;height:64px"
          onclick="this.textContent='Website clicks: '+(++window.clicks)">Website clicks: 0</button>
        <output aria-label="Live updates" style="position:absolute;left:32px;top:290px">0</output>
        <script>window.clicks=0;let ticks=0;setInterval(()=>document.querySelector('output').textContent=String(++ticks),100)</script>
      </body></html>`,
  }));
  await page.goto('/');
  expect((await page.request.post(new URL('api/layout/settings', page.url()).href, {
    data: { sidebarWidth: 240, chatRatio: .85 / 2.35 },
  })).ok()).toBe(true);
  await page.reload();
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  const initial = await state(page);
  const live = initial.board.elements.filter((element: any) => !element.isDeleted);
  if (live.length) {
    await page.evaluate(async ({ revision, operations }) => {
      const response = await fetch(new URL('api/board/mutate', location.href), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), observedBoardRevision: revision, operations }),
      });
      if (!response.ok) throw new Error('Could not clear the browser-frame test canvas.');
    }, {
      revision: initial.board.revision,
      operations: live.map((element: any) => ({ kind: 'delete', elementId: element.id, expectedRevision: initial.board.metadata[element.id].revision })),
    });
    await page.reload();
    await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  }
}

async function addWebsite(page: Page) {
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add website to canvas', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Website address', exact: true }).fill('canvas-preview.test');
  await dialog.getByRole('button', { name: 'Add to canvas', exact: true }).click();
  await expect(dialog).toBeHidden();
  const iframe = page.locator('iframe[title="Canvas website"]');
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toHaveAttribute('src', preview);
  const frame = page.frameLocator('iframe[title="Canvas website"]');
  await expect(frame.getByRole('heading', { name: 'Live canvas preview', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Draw on canvas', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Browse website', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'embeddable').length).toBe(1);
  return { iframe, frame };
}

async function drawAcrossWebsite(page: Page) {
  const iframe = (await page.locator('iframe[title="Canvas website"]').boundingBox())!;
  await page.getByRole('radio', { name: 'Draw', exact: true }).check();
  const actions = await page.locator('.excalidraw .App-menu__left').evaluateAll(elements => {
    for (const element of elements) {
      const bounds = element.getBoundingClientRect();
      if (bounds.width && bounds.height && getComputedStyle(element).visibility !== 'hidden') {
        return { x: bounds.x, width: bounds.width };
      }
    }
    return null;
  });
  // The shape properties sidebar floats over the left part of the website.
  // Start on exposed canvas, so the gesture cannot begin on a sidebar control.
  const start = Math.max(iframe.x + 20, actions ? actions.x + actions.width + 24 : 0);
  const end = iframe.x + iframe.width - 20;
  const y = iframe.y + Math.min(220, iframe.height - 30);
  expect(end - start).toBeGreaterThan(100);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('canvas.interactive'), { x: start, y })).toBe(true);
  await page.mouse.move(start, y);
  await page.mouse.down();
  await page.mouse.move(end, y, { steps: 20 });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'freedraw' && element.points.length > 10).length).toBe(1);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  return { x: start + 12, y: y - 8, width: end - start - 24, height: 16 };
}

async function darkPixels(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  // Browser-composited pixels catch an iframe covering the completed stroke,
  // even when the Excalidraw canvas itself contains the expected ink.
  const screenshot = await page.screenshot({ clip });
  return page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] && Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < 180) ink++;
    }
    return ink;
  }, screenshot.toString('base64'));
}

test('a live website accepts input in Browse and saved Excalidraw ink overlays it in Draw, reload and export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptyCanvas(page);
  const { frame } = await addWebsite(page);
  const added = (await state(page)).board.elements.find((element: any) => !element.isDeleted && element.type === 'embeddable');
  expect(added.link).toBe(preview);
  expect(added.customData.canvagent).toMatchObject({ kind: 'browser', version: 1 });

  const updates = frame.getByLabel('Live updates', { exact: true });
  const before = await updates.textContent();
  await expect.poll(() => updates.textContent()).not.toBe(before);
  const clip = await drawAcrossWebsite(page);
  expect(await darkPixels(page, clip)).toBeGreaterThan(60);
  await page.screenshot({ path: 'test-results/browser-frame-preview.png' });
  const drawn = (await state(page)).board.elements.find((element: any) => !element.isDeleted && element.type === 'freedraw' && element.points.length > 10);
  expect(drawn.type).toBe('freedraw');

  await page.getByRole('button', { name: 'Browse website', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Browse website', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await frame.getByRole('button', { name: 'Website clicks: 0', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Website clicks: 1', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Draw on canvas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Draw on canvas', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const button = (await frame.getByRole('button', { name: 'Website clicks: 1', exact: true }).boundingBox())!;
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('canvas.interactive'), { x: button.x + button.width / 2, y: button.y + button.height / 2 })).toBe(true);
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await expect(frame.getByRole('button', { name: 'Website clicks: 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Draw on canvas', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await darkPixels(page, clip)).toBeGreaterThan(60);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.excalidraw$/);
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(exported.elements.find((element: any) => element.id === added.id)).toMatchObject({ type: 'embeddable', link: preview, customData: { canvagent: { kind: 'browser', version: 1 } } });
  expect(exported.elements.find((element: any) => element.id === drawn.id).points).toEqual(drawn.points);

  await page.reload();
  await expect(page.locator('iframe[title="Canvas website"]')).toHaveAttribute('src', preview);
  await expect(frame.getByRole('heading', { name: 'Live canvas preview', exact: true })).toBeVisible();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  const restored = await state(page);
  expect(restored.board.elements.find((element: any) => element.id === added.id)).toMatchObject({ type: 'embeddable', link: preview, customData: { canvagent: { kind: 'browser', version: 1 } } });
  expect(restored.board.elements.find((element: any) => element.id === drawn.id).points).toEqual(drawn.points);
  expect(errors).toEqual([]);
});

test('the live website follows canvas zoom and pan without changing its saved frame geometry', async ({ page }) => {
  await openEmptyCanvas(page);
  const { iframe, frame } = await addWebsite(page);
  const saved = (await state(page)).board.elements.find((element: any) => !element.isDeleted && element.type === 'embeddable');
  const original = (await iframe.boundingBox())!;
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(async () => (await iframe.boundingBox())!.width).toBeLessThan(original.width * .95);
  const zoomed = (await iframe.boundingBox())!;

  await page.locator('.excalidraw').focus();
  await page.keyboard.down('Space');
  await page.mouse.move(zoomed.x + zoomed.width / 2, zoomed.y + zoomed.height / 2);
  await page.mouse.down();
  await page.mouse.move(zoomed.x + zoomed.width / 2 + 60, zoomed.y + zoomed.height / 2 + 45, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect.poll(async () => Math.round((await iframe.boundingBox())!.x - zoomed.x)).toBe(60);
  await expect.poll(async () => Math.round((await iframe.boundingBox())!.y - zoomed.y)).toBe(45);
  expect((await iframe.boundingBox())!.width).toBeCloseTo(zoomed.width, 1);
  const after = (await state(page)).board.elements.find((element: any) => element.id === saved.id);
  expect({ x: after.x, y: after.y, width: after.width, height: after.height }).toEqual({ x: saved.x, y: saved.y, width: saved.width, height: saved.height });

  await page.getByRole('button', { name: 'Browse website', exact: true }).click();
  await frame.getByRole('button', { name: 'Website clicks: 0', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Website clicks: 1', exact: true })).toBeVisible();
});

test('website frames reject unsupported schemes, credentials and embedding Canvagent itself', async ({ page }) => {
  await openEmptyCanvas(page);
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add website to canvas', exact: true });
  for (const address of ['file:///tmp/preview.html', 'javascript://example.com', 'https://user:password@example.com', new URL(page.url()).origin]) {
    await dialog.getByRole('textbox', { name: 'Website address', exact: true }).fill(address);
    await dialog.getByRole('button', { name: 'Add to canvas', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect((await state(page)).board.elements.filter((element: any) => !element.isDeleted)).toHaveLength(0);
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('iframe[title="Canvas website"]')).toHaveCount(0);
});

test('website frames remain native editable objects through move, resize, undo and deletion', async ({ page }) => {
  await openEmptyCanvas(page);
  const { iframe } = await addWebsite(page);
  const original = (await state(page)).board.elements.find((element: any) => !element.isDeleted && element.type === 'embeddable');
  await page.getByRole('button', { name: 'Select website frame', exact: true }).click();
  await expect(page.locator('.selection-chip')).toContainText('1 object selected');
  const beforeMove = (await iframe.boundingBox())!;
  const start = { x: beforeMove.x + beforeMove.width * .75, y: beforeMove.y + beforeMove.height * .4 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 20, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).board.elements.find((element: any) => element.id === original.id).x).not.toBe(original.x);
  const moved = (await state(page)).board.elements.find((element: any) => element.id === original.id);
  expect(moved.width).toBe(original.width);
  expect(moved.height).toBe(original.height);
  expect(moved.link).toBe(preview);

  const beforeResize = (await iframe.boundingBox())!;
  await page.mouse.move(beforeResize.x + beforeResize.width + 1, beforeResize.y + beforeResize.height + 1);
  await page.mouse.down();
  await page.mouse.move(beforeResize.x + beforeResize.width - 69, beforeResize.y + beforeResize.height - 49, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).board.elements.find((element: any) => element.id === original.id).width).toBeLessThan(original.width - 40);
  expect((await iframe.boundingBox())!.width).toBeLessThan(beforeResize.width - 35);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await state(page)).board.elements.find((element: any) => element.id === original.id).width).toBe(moved.width);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await state(page)).board.elements.find((element: any) => element.id === original.id).x).toBe(original.x);
  expect((await state(page)).board.elements.find((element: any) => element.id === original.id).y).toBe(original.y);

  await page.getByRole('button', { name: 'Select website frame', exact: true }).click();
  await page.locator('.excalidraw').focus();
  await page.keyboard.press('Backspace');
  await expect(iframe).toHaveCount(0);
  await expect.poll(async () => (await state(page)).board.elements.find((element: any) => element.id === original.id).isDeleted).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toHaveAttribute('src', preview);
  await expect.poll(async () => (await state(page)).board.elements.filter((element: any) => !element.isDeleted && element.type === 'embeddable').length).toBe(1);
  expect((await state(page)).board.elements.find((element: any) => element.id === original.id)).toMatchObject({ isDeleted: false, x: original.x, y: original.y, width: original.width, height: original.height });
});

test('changing a validated website link cannot reuse its cached validation to embed Canvagent', async ({ page }) => {
  await openEmptyCanvas(page);
  const { iframe } = await addWebsite(page);
  const saved = await state(page);
  const website = saved.board.elements.find((element: any) => !element.isDeleted && element.type === 'embeddable');
  const invalidUrl = new URL('/bad-embed', page.url()).href;
  const forbiddenRequests: string[] = [];
  await page.route(invalidUrl, route => {
    forbiddenRequests.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<h1>Forbidden same-origin embed</h1>' });
  });
  const response = await page.request.post(new URL('api/board/mutate', page.url()).href, {
    data: {
      requestId: crypto.randomUUID(), observedBoardRevision: saved.board.revision,
      operations: [{ kind: 'update', elementId: website.id, expectedRevision: saved.board.metadata[website.id].revision, patch: { link: invalidUrl } }],
    },
  });
  expect(response.ok()).toBe(true);
  expect((await response.json()).ok).toBe(true);
  await expect(iframe).toHaveCount(0);
  expect(await page.locator('iframe').evaluateAll(frames => frames.filter(frame => frame instanceof HTMLIFrameElement && new URL(frame.src, location.href).origin === location.origin).length)).toBe(0);
  expect(forbiddenRequests).toEqual([]);
});
