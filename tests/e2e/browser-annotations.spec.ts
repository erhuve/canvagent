import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

const preview = 'https://preview.test/start';
test.afterEach(async ({ page }) => {
  if (page.url().includes('/projects/')) await page.request.post(new URL('api/layout/settings', page.url()).href, { data: { sidebarWidth: 240, chatRatio: .85 / 2.35 } });
});

async function openPreview(page: Page) {
  await page.route('https://preview.test/**', route => {
    const next = new URL(route.request().url()).pathname === '/next';
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Annotation fixture</title></head><body style="margin:0;font:16px sans-serif"><h1>${next ? 'Next preview page' : 'Cross-origin preview'}</h1><button style="position:absolute;left:40px;top:100px;width:200px;height:80px" onclick="this.textContent='Page clicks: '+(++window.clicks)">Page clicks: 0</button><a style="position:absolute;left:40px;top:230px" href="/next">Next preview</a><script>window.clicks=0</script></body></html>` });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await page.getByRole('textbox', { name: 'Browser address', exact: true }).fill(preview);
  await page.getByRole('button', { name: 'Go to address', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Project browser"]');
  await expect(frame.getByRole('heading', { name: 'Cross-origin preview', exact: true })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Annotate browser', exact: true });
  await expect(toggle).toBeEnabled();
  return { frame, toggle, canvas: page.locator('.browser-viewport [data-canvagent-annotation-canvas]') };
}

async function pixels(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let ink = 0, red = 0, yellow = 0, blue = 0, translucent = 0, maxAlpha = 0, yellowAlpha = 0;
    for (let index = 0; index < data.length; index += 4) {
      const [r, g, b, a] = [data[index], data[index + 1], data[index + 2], data[index + 3]];
      if (!a) continue;
      ink += 1;
      maxAlpha = Math.max(maxAlpha, a);
      if (a < 150) translucent += 1;
      if (r > 180 && g < 120 && b < 120) red += 1;
      if (r > 180 && g > 130 && b < 100) { yellow += 1; yellowAlpha = Math.max(yellowAlpha, a); }
      if (r < 120 && g < 170 && b > 180) blue += 1;
    }
    return { ink, red, yellow, blue, translucent, maxAlpha, yellowAlpha, width: element.width, height: element.height };
  });
}

async function stroke(page: Page, canvas: Locator, from: [number, number], to: [number, number]) {
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + from[0], bounds.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(bounds.x + to[0], bounds.y + to[1], { steps: 12 });
  await page.mouse.up();
}

test('browser annotations draw pen, highlight and rectangles while shielding page clicks, then undo and clear', async ({ page }) => {
  const { frame, toggle, canvas } = await openPreview(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Annotation pen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).toBeVisible();
  expect((await pixels(canvas)).ink).toBe(0);
  await stroke(page, canvas, [60, 120], [200, 150]);
  await expect.poll(async () => (await pixels(canvas)).red).toBeGreaterThan(100);
  await expect(page.locator('.annotation-count')).toHaveText('1 annotation');
  await expect(frame.getByRole('button', { name: 'Page clicks: 0', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Annotation color: Yellow', exact: true }).click();
  await page.getByRole('button', { name: 'Annotation highlighter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Annotation highlighter', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Annotation color: Yellow', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await stroke(page, canvas, [60, 310], [220, 330]);
  await expect.poll(async () => (await pixels(canvas)).yellow).toBeGreaterThan(100);
  expect((await pixels(canvas)).translucent).toBeGreaterThan(100);
  expect((await pixels(canvas)).yellowAlpha).toBeGreaterThan(60);
  expect((await pixels(canvas)).yellowAlpha).toBeLessThan(120);

  await page.getByRole('button', { name: 'Annotation color: Blue', exact: true }).click();
  await page.getByRole('button', { name: 'Annotation rectangle', exact: true }).click();
  await stroke(page, canvas, [280, 170], [420, 270]);
  await expect(page.locator('.annotation-count')).toHaveText('3 annotations');
  expect((await pixels(canvas)).blue).toBeGreaterThan(100);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => {
    const bounds = element.getBoundingClientRect();
    return element.getContext('2d')!.getImageData(Math.round(350 * element.width / bounds.width), Math.round(220 * element.height / bounds.height), 1, 1).data[3];
  })).toBe(0);
  await page.getByRole('button', { name: 'Undo browser annotation', exact: true }).click();
  await expect(page.locator('.annotation-count')).toHaveText('2 annotations');
  expect((await pixels(canvas)).blue).toBe(0);
  expect((await pixels(canvas)).red).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Clear browser annotations', exact: true }).click();
  await expect(page.locator('.annotation-count')).toHaveText('0 annotations');
  expect((await pixels(canvas)).ink).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo browser annotation', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Annotation pen', exact: true }).click();
  await stroke(page, canvas, [70, 125], [190, 145]);
  await expect(page.locator('.annotation-count')).toHaveText('1 annotation');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await frame.getByRole('button', { name: 'Page clicks: 0', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Page clicks: 1', exact: true })).toBeVisible();
  expect((await pixels(canvas)).ink).toBeGreaterThan(100);
});

test('browser ink survives viewport and pane resizing, then clears on iframe navigation without an address change', async ({ page }) => {
  const { frame, toggle, canvas } = await openPreview(page);
  await toggle.click();
  await expect(canvas).toBeVisible();
  await stroke(page, canvas, [40, 70], [220, 90]);
  await expect(page.locator('.annotation-count')).toHaveText('1 annotation');
  const initial = await pixels(canvas);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(async () => (await pixels(canvas)).width).toBeGreaterThan(initial.width);
  await expect.poll(async () => (await pixels(canvas)).ink).toBeGreaterThan(initial.ink * .8);
  const handle = page.getByRole('separator', { name: 'Resize chat and workspace', exact: true });
  const bounds = (await handle.boundingBox())!;
  const before = await pixels(canvas);
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/layout/settings') && response.ok());
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 100, { steps: 8 });
  await page.mouse.up();
  await saved;
  await expect.poll(async () => (await pixels(canvas)).width).toBeLessThan(before.width);
  await expect.poll(async () => (await pixels(canvas)).ink).toBeGreaterThan(initial.ink * .8);
  expect((await pixels(canvas)).height).toBeGreaterThan(100);
  await expect(page.locator('.annotation-count')).toHaveText('1 annotation');

  await toggle.click();
  await frame.getByRole('link', { name: 'Next preview', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Next preview page', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(preview);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(canvas).toHaveCount(0);
  await toggle.click();
  await expect(canvas).toBeVisible();
  expect((await pixels(canvas)).ink).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo browser annotation', exact: true })).toBeDisabled();
  await stroke(page, canvas, [50, 70], [150, 90]);
  await expect(page.locator('.annotation-count')).toHaveText('1 annotation');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('leaving Browser stops drawing without consuming Escape in the file picker or discarding marks', async ({ page }) => {
  const { toggle, canvas } = await openPreview(page);
  await toggle.click();
  await stroke(page, canvas, [50, 70], [180, 110]);
  await expect(page.locator('.annotation-count')).toHaveText('1 annotation');
  const ink = (await pixels(canvas)).ink;
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your project files', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+P');
  const picker = page.getByRole('dialog', { name: 'Quick Open', exact: true });
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.annotation-count')).toHaveText('1 annotation');
  await expect.poll(async () => (await pixels(canvas)).ink).toBeGreaterThan(ink * .8);
});
