import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

type Mode = 'normal' | 'insert' | 'disabled';
const source = 'const label = "outside";\nexport function Example() {\n  return (\n    <section>\n      <span>{label}</span>\n      <strong>More</strong>\n    </section>\n  );\n}\n';
const childLine = 5;

async function freshProject(page: Page, name: string, contents = source) {
  const workspace = await mkdtemp(join(tmpdir(), 'canvagent-comments-'));
  await writeFile(join(workspace, name), contents);
  await page.request.get('/api/projects');
  const response = await page.request.post('/api/projects', { data: { workspace } });
  expect(response.ok()).toBe(true);
  const project = await response.json() as { path: string };
  return { workspace, path: project.path };
}

async function openEditor(page: Page, projectPath: string, name: string, mode: Mode) {
  await page.goto(projectPath);
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: `Open file: ${name}`, exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'File contents', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveJSProperty('readOnly', false);
  const vim = page.getByRole('button', { name: 'Vim key bindings', exact: true });
  await expect(vim).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[aria-label="Vim status"]')).toContainText('NORMAL');
  await expect.poll(() => page.locator('.monaco-code-editor .view-line span[class^="mtk"]').evaluateAll(tokens => new Set(tokens.map(token => token.className)).size)).toBeGreaterThan(1);
  if (mode === 'disabled') {
    await vim.click();
    await expect(vim).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[aria-label="Vim status"]')).toBeHidden();
  }
  return editor;
}

async function position(page: Page, editor: Locator, mode: Mode, line: number) {
  await editor.focus();
  if (mode !== 'disabled') {
    await editor.press('Escape');
    await page.keyboard.type(`gg${line > 1 ? `${line - 1}j` : ''}`);
    if (mode === 'insert') await editor.press('i');
    await expect(page.locator('[aria-label="Vim status"]')).toContainText(mode === 'insert' ? 'INSERT' : 'NORMAL');
  } else {
    await editor.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
    for (let index = 1; index < line; index++) await editor.press('ArrowDown');
  }
}

async function save(page: Page, editor: Locator, path: string, expected: string) {
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path, 'utf8')).toBe(expected);
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();
}

async function commentAndRead(page: Page, editor: Locator, path: string, original: string) {
  await editor.press('ControlOrMeta+/');
  // Save immediately: worker-backed comment edits must finish before the save.
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path, 'utf8')).not.toBe(original);
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();
  return readFile(path, 'utf8');
}

for (const extension of ['tsx', 'jsx']) {
  for (const mode of ['normal', 'insert', 'disabled'] as const) {
    test(`${extension} comment toggling uses JSX wrappers and code line comments with Vim ${mode}`, async ({ page }) => {
      const name = `Example.${extension}`;
      const project = await freshProject(page, name);
      const path = join(project.workspace, name);
      try {
        const editor = await openEditor(page, project.path, name, mode);
        await position(page, editor, mode, childLine);
        const commented = await commentAndRead(page, editor, path, source);
        const lines = commented.split('\n');
        expect(lines[childLine - 1]).toMatch(/^\s*\{\/\*\s*<span>\{label\}<\/span>\s*\*\/\}\s*$/);
        expect(lines.filter((_line, index) => index !== childLine - 1)).toEqual(source.split('\n').filter((_line, index) => index !== childLine - 1));
        await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();

        await editor.press('ControlOrMeta+/');
        await save(page, editor, path, source);
        if (mode === 'normal') await editor.press('Escape');
        await editor.press(mode === 'normal' ? 'u' : 'ControlOrMeta+z');
        await save(page, editor, path, commented);
        await editor.press(mode === 'normal' ? 'u' : 'ControlOrMeta+z');
        await save(page, editor, path, source);

        await position(page, editor, mode, 1);
        await editor.press('ControlOrMeta+/');
        await save(page, editor, path, `// ${source}`);
        await editor.press('ControlOrMeta+/');
        await save(page, editor, path, source);
      } finally {
        await rm(project.workspace, { recursive: true, force: true });
      }
    });
  }

  test(`${extension} fragment children use JSX comments with default Vim`, async ({ page }) => {
    const name = `Fragment.${extension}`;
    const fragment = source.replace('<section>', '<>').replace('</section>', '</>');
    const project = await freshProject(page, name, fragment);
    const path = join(project.workspace, name);
    try {
      const editor = await openEditor(page, project.path, name, 'normal');
      await position(page, editor, 'normal', childLine);
      const commented = await commentAndRead(page, editor, path, fragment);
      expect(commented.split('\n')[childLine - 1]).toMatch(/^\s*\{\/\*\s*<span>\{label\}<\/span>\s*\*\/\}\s*$/);
      await editor.press('ControlOrMeta+/');
      await save(page, editor, path, fragment);
      await editor.press('u');
      await save(page, editor, path, commented);
    } finally { await rm(project.workspace, { recursive: true, force: true }); }
  });

  for (const mode of ['normal', 'disabled'] as const) {
    test(`${extension} selected JSX siblings toggle as valid comments with Vim ${mode}`, async ({ page }) => {
      const name = `Siblings.${extension}`;
      const project = await freshProject(page, name);
      const path = join(project.workspace, name);
      try {
        const editor = await openEditor(page, project.path, name, mode);
        await position(page, editor, mode, childLine);
        if (mode === 'normal') await page.keyboard.type('Vj');
        else { await editor.press('Shift+ArrowDown'); await editor.press('Shift+ArrowDown'); }
        const commented = await commentAndRead(page, editor, path, source);
        expect(commented).toContain('{/*');
        expect(commented.startsWith(source.split('\n').slice(0, childLine - 1).join('\n') + '\n')).toBe(true);
        expect(commented.endsWith(source.split('\n').slice(childLine + 1).join('\n'))).toBe(true);
        const parsed = ts.createSourceFile(name, commented, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const tags: string[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) tags.push(node.tagName.getText(parsed));
          ts.forEachChild(node, visit);
        };
        visit(parsed);
        expect(tags).toEqual(['section']);
        const compilation = ts.transpileModule(commented, { fileName: name, compilerOptions: { jsx: ts.JsxEmit.Preserve }, reportDiagnostics: true });
        expect(compilation.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([]);
        await editor.press('ControlOrMeta+/');
        await save(page, editor, path, source);
        if (mode === 'normal') await editor.press('Escape');
        await editor.press(mode === 'normal' ? 'u' : 'ControlOrMeta+z');
        await save(page, editor, path, commented);
      } finally { await rm(project.workspace, { recursive: true, force: true }); }
    });
  }
}

test('mixed JavaScript and JSX cursors toggle both contexts together and undo as one change', async ({ page }) => {
  const name = 'Mixed.tsx';
  const project = await freshProject(page, name);
  const path = join(project.workspace, name);
  try {
    const editor = await openEditor(page, project.path, name, 'disabled');
    await position(page, editor, 'disabled', 1);
    for (let index = 0; index < 'const '.length; index++) await editor.press('ArrowRight');
    for (let index = 0; index < 'label'.length; index++) await editor.press('Shift+ArrowRight');
    await editor.press('ControlOrMeta+d');
    await expect(page.locator('.monaco-code-editor .cursors-layer .cursor')).toHaveCount(2);
    const commented = await commentAndRead(page, editor, path, source);
    const lines = commented.split('\n');
    expect(lines[0]).toBe(`// ${source.split('\n')[0]}`);
    expect(lines[childLine - 1]).toMatch(/^\s*\{\/\*\s*<span>\{label\}<\/span>\s*\*\/\}\s*$/);
    expect(lines.filter((_line, index) => index !== 0 && index !== childLine - 1)).toEqual(source.split('\n').filter((_line, index) => index !== 0 && index !== childLine - 1));
    await expect(page.locator('.monaco-code-editor .cursors-layer .cursor')).toHaveCount(2);
    await editor.press('ControlOrMeta+/');
    await save(page, editor, path, source);
    await editor.press('ControlOrMeta+z');
    await save(page, editor, path, commented);
  } finally { await rm(project.workspace, { recursive: true, force: true }); }
});
