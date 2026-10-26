import { expect, test, type Page } from '@playwright/test';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function mockNativeBrowser(page: Page, scenario: 'delayed-hide' | 'empty-open' | 'open-rejection') {
  await page.addInitScript(({ scenario }) => {
    const browser = {
      url: '', title: '', loading: false, error: undefined as string | undefined,
      visible: false, stateReads: 0,
      allowState: scenario !== 'empty-open', releaseStateReads: [] as (() => void)[],
      calls: [] as { command: string; args?: Record<string, any> }[],
      annotations: { active: false, tool: 'pen', color: '#e5484d', count: 0, canUndo: false, documentId: 'doc-1' },
    };
    (window as any).__nativeBrowserMock = browser;
    const snapshot = () => ({ url: browser.url, title: browser.title, loading: browser.loading, error: browser.error, canGoBack: false, canGoForward: false });
    (window as any).__TAURI__ = { core: { invoke: async (command: string, args?: Record<string, any>) => {
      browser.calls.push({ command, args });
      if (command === 'browser_open') {
        browser.url = args!.url;
        if (scenario === 'open-rejection') {
          browser.error = 'Native view could not open localhost:3000.';
          throw new Error(browser.error);
        }
        browser.title = 'Local preview';
        browser.loading = scenario === 'empty-open';
        browser.visible = true;
        return scenario === 'empty-open' ? { url: '', loading: false } : snapshot();
      }
      if (command === 'browser_bounds') { browser.visible = true; return null; }
      if (command === 'browser_hide' || command === 'browser_close') {
        if (scenario === 'delayed-hide' && browser.url) await new Promise(resolve => setTimeout(resolve, 150));
        browser.visible = false;
        return null;
      }
      if (command === 'browser_state') {
        browser.stateReads += 1;
        if (!browser.allowState) await new Promise<void>(resolve => browser.releaseStateReads.push(resolve));
        return snapshot();
      }
      if (command === 'browser_action') { browser.loading = true; browser.error = undefined; return snapshot(); }
      if (command === 'browser_annotate') {
        if (args?.tool) browser.annotations.tool = args.tool;
        if (args?.color) browser.annotations.color = args.color;
        if (args?.command === 'start') browser.annotations.active = true;
        if (args?.command === 'stop') browser.annotations.active = false;
        if (args?.command === 'clear') browser.annotations.count = 0;
        if (args?.command === 'undo') browser.annotations.count = Math.max(0, browser.annotations.count - 1);
        browser.annotations.canUndo = browser.annotations.count > 0;
        return { ...browser.annotations };
      }
      return null;
    } } };
  }, { scenario });
}

async function openLocalPreview(page: Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await page.getByRole('textbox', { name: 'Browser address', exact: true }).fill('localhost:3000');
  await page.getByRole('button', { name: 'Go to address', exact: true }).click();
}

test('native navigation and redirect polling keep the view visible, and returning to its tab restores it', async ({ page }) => {
  await mockNativeBrowser(page, 'delayed-hide');
  await openLocalPreview(page);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.stateReads)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(true);
  const reads = await page.evaluate(() => (window as any).__nativeBrowserMock.stateReads);
  await page.evaluate(() => { (window as any).__nativeBrowserMock.url = 'http://localhost:3000/redirected'; });
  await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue('http://localhost:3000/redirected');
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.stateReads)).toBeGreaterThanOrEqual(reads + 2);
  expect(await page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(true);

  await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(false);
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(true);
  const rectangles = await page.evaluate(() => (window as any).__nativeBrowserMock.calls.filter((call: any) => call.command === 'browser_bounds').map((call: any) => call.args.bounds));
  expect(rectangles.length).toBeGreaterThan(0);
  expect(rectangles.every((rectangle: any) => rectangle.width > 0 && rectangle.height > 0)).toBe(true);
});

test('an early empty native snapshot keeps the requested page and exposes loading and later failure', async ({ page }) => {
  await mockNativeBrowser(page, 'empty-open');
  await openLocalPreview(page);
  await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue('http://localhost:3000/');
  await expect(page.getByRole('status', { name: 'Loading browser page', exact: true })).toContainText('Loading page');
  await expect(page.getByRole('heading', { name: 'A browser beside your work', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload browser', exact: true })).toBeEnabled();

  await page.evaluate(() => {
    const browser = (window as any).__nativeBrowserMock;
    browser.loading = false;
    browser.error = 'Could not load http://localhost:3000: connection refused.';
    browser.allowState = true;
    browser.releaseStateReads.forEach((resolve: () => void) => resolve());
  });
  await expect(page.getByRole('alert')).toContainText('connection refused');
  await expect(page.getByRole('status', { name: 'Loading browser page', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(false);
});

test('a rejected native open displays its failure and keeps reload available for the requested address', async ({ page }) => {
  await mockNativeBrowser(page, 'open-rejection');
  await openLocalPreview(page);
  await expect(page.getByRole('alert')).toContainText('Native view could not open localhost:3000.');
  await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue('http://localhost:3000/');
  await expect(page.getByRole('button', { name: 'Reload browser', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'A browser beside your work', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(false);
});

test('native browser stays hidden throughout pane dragging and returns at its new bounds', async ({ page }) => {
  await mockNativeBrowser(page, 'delayed-hide');
  await openLocalPreview(page);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(true);
  const handle = page.getByRole('separator', { name: 'Resize chat and workspace', exact: true });
  const rectangle = await handle.boundingBox();
  expect(rectangle).not.toBeNull();
  await page.mouse.move(rectangle!.x + rectangle!.width / 2, rectangle!.y + 100);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(false);
  const before = await page.evaluate(() => (window as any).__nativeBrowserMock.calls.filter((call: any) => call.command === 'browser_bounds').length);
  await page.mouse.move(rectangle!.x + 100, rectangle!.y + 100, { steps: 6 });
  await page.waitForTimeout(750);
  expect(await page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(false);
  expect(await page.evaluate(() => (window as any).__nativeBrowserMock.calls.filter((call: any) => call.command === 'browser_bounds').length)).toBe(before);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.visible)).toBe(true);
  const bounds = await page.locator('.browser-viewport').boundingBox();
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.calls.filter((call: any) => call.command === 'browser_bounds').at(-1)?.args.bounds.width)).toBeCloseTo(bounds!.width, 0);
});

test('native annotation controls support Escape, preserve chosen tools, and stop when hidden', async ({ page }) => {
  await mockNativeBrowser(page, 'delayed-hide');
  await openLocalPreview(page);
  const toggle = page.getByRole('button', { name: 'Annotate browser', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Annotation highlighter', exact: true }).click();
  await page.getByRole('button', { name: 'Annotation color: Purple', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Annotation highlighter', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Toolbar focus belongs to the app, while the page has its own webview.
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Annotation color: Purple', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    (window as any).__nativeBrowserMock.annotations = { active: false, tool: 'pen', color: '#e5484d', count: 0, canUndo: false, documentId: 'doc-2' };
  });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Annotation color: Purple', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Annotation highlighter', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__nativeBrowserMock.annotations.active)).toBe(false);
});
