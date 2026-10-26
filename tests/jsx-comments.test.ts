import assert from 'node:assert/strict';
import test from 'node:test';
import type * as TypeScript from 'typescript';
import { jsxCommentEdits, type CommentRange, type CommentTextChange } from '../src/shared/jsx-comments';

// Exercise the exact parser bundled into the product's worker, not a second
// development dependency that could drift to different JSX comment behavior.
const bundled = await import('monaco-editor/languages/features/typescript/lib/typescriptServices.js' as string);
const ts = bundled.typescript as typeof TypeScript;

function fixture(text: string, extension = 'tsx') {
  const fileName = `/fixture.${extension}`;
  const service = ts.createLanguageService({
    getCompilationSettings: () => ({ jsx: ts.JsxEmit.Preserve, allowJs: true, noLib: true }),
    getScriptFileNames: () => [fileName], getScriptVersion: () => '1',
    getScriptSnapshot: name => name === fileName ? ts.ScriptSnapshot.fromString(text) : undefined,
    getCurrentDirectory: () => '/', getDefaultLibFileName: () => 'lib.d.ts',
    fileExists: name => name === fileName, readFile: name => name === fileName ? text : undefined,
  });
  const source = service.getProgram()!.getSourceFile(fileName)!;
  return {
    source,
    diagnostics: () => service.getSyntacticDiagnostics(fileName),
    range(firstLine: number, lastLine = firstLine, nextLineColumnOne = false): CommentRange {
      const starts = source.getLineStarts();
      return { pos: starts[firstLine], end: nextLineColumnOne ? starts[lastLine + 1] : source.getLineEndOfPosition(starts[lastLine]) };
    },
    edits(ranges: CommentRange[], insertSpace = true) { return jsxCommentEdits(ts, service, source, ranges, insertSpace); },
  };
}

function apply(text: string, edits: CommentTextChange[] | null) {
  assert.notEqual(edits, null);
  let output = text;
  for (const edit of [...edits!].sort((a, b) => b.span.start - a.span.start)) output = output.slice(0, edit.span.start) + edit.newText + output.slice(edit.span.start + edit.span.length);
  return output;
}

test('comments JSX element and fragment children using the existing language service', () => {
  for (const [open, close] of [['<main>', '</main>'], ['<>', '</>']]) {
    for (const extension of ['tsx', 'jsx']) {
      const text = `const view = (\n  ${open}\n    <span>Hello</span>\n  ${close}\n);`;
      const page = fixture(text, extension);
      const output = apply(text, page.edits([page.range(2)]));
      assert.equal(output, `const view = (\n  ${open}\n    {/* <span>Hello</span> */}\n  ${close}\n);`);
      assert.equal(page.source.text, text, 'worker source remains unchanged');
      const commented = fixture(output, extension);
      assert.equal(apply(output, commented.edits([commented.range(2)])), text);
    }
  }
});

test('multiline JSX selection excludes next-line column one and toggles as one block', () => {
  const text = 'const view = (\n  <>\n    <section>\n      <span>Hello</span>\n    </section>\n    <footer />\n  </>\n);';
  const page = fixture(text);
  const output = apply(text, page.edits([page.range(2, 4, true)]));
  assert.equal(output, 'const view = (\n  <>\n    {/* <section>\n      <span>Hello</span>\n    </section> */}\n    <footer />\n  </>\n);');
  const commented = fixture(output);
  assert.equal(apply(output, commented.edits([commented.range(2, 4, true)])), text);
});

test('existing compact and multiline JSX comments unwrap without duplicating delimiters', () => {
  const compact = 'const view = <main>\n  {/*<span />*/}\n</main>;';
  const page = fixture(compact);
  assert.equal(apply(compact, page.edits([page.range(1)])), 'const view = <main>\n  <span />\n</main>;');
  const empty = 'const view = <>\n  {/* */}\n</>;';
  const emptyPage = fixture(empty);
  const emptyEdits = emptyPage.edits([emptyPage.range(1)])!;
  assert.equal(emptyEdits.length, 1, 'shared empty-comment padding is removed once');
  assert.equal(apply(empty, emptyEdits), 'const view = <>\n  \n</>;');
  const multiline = 'const view = <>\n  {/*\n    <span />\n  */}\n</>;';
  const block = fixture(multiline);
  assert.equal(apply(multiline, block.edits([block.range(1, 3)])), 'const view = <>\n  \n    <span />\n  \n</>;');
});

test('ordinary TS, expressions, strings and templates delegate to Monaco', () => {
  for (const text of ['const value = 1;', 'const text = "<span />";', 'const text = `\n  <span />\n`;']) {
    const page = fixture(text);
    assert.equal(page.edits([page.range(text.includes('`') ? 1 : 0)]), null);
  }
  const text = 'const view = <main>\n  {items.map(item => {\n    const name = item.name;\n    return <span>{name}</span>;\n  })}\n</main>;';
  const page = fixture(text);
  assert.equal(page.edits([page.range(2)]), null);
  assert.equal(page.edits([page.range(3)]), null);
  assert.equal(page.edits([page.range(0, 5)]), null, 'a whole JS declaration keeps ordinary line comments');
});

test('mixed JSX and JS selections produce one correctly spaced edit batch', () => {
  const text = 'const count = 1;\nconst view = <>\n  <span />\n</>;';
  const page = fixture(text);
  const output = apply(text, page.edits([page.range(0), page.range(2)]));
  assert.equal(output, '// const count = 1;\nconst view = <>\n  {/* <span /> */}\n</>;');
  const commented = fixture(output);
  assert.equal(apply(output, commented.edits([commented.range(0), commented.range(2)])), text);
  const tight = apply(text, page.edits([page.range(0), page.range(2)], false));
  assert.equal(tight, '//const count = 1;\nconst view = <>\n  {/*<span />*/}\n</>;');
  const padded = fixture(output);
  assert.equal(apply(output, padded.edits([padded.range(0), padded.range(2)], false)), ' const count = 1;\nconst view = <>\n   <span /> \n</>;', 'disabled insertSpace preserves existing delimiter padding like Monaco');
});

test('multiline JSX tag attributes retain valid ordinary comments', () => {
  const text = 'const view = <main>\n  <Child\n    value="hello"\n    onClick={() => console.log("hello")}\n  />\n  <span />\n</main>;';
  const page = fixture(text);
  assert.equal(page.diagnostics().length, 0);
  assert.equal(page.edits([page.range(2)]), null, 'attribute-only selection delegates to Monaco');
  assert.equal(page.edits([page.range(3)]), null, 'attribute expression line delegates to Monaco');
  const output = apply(text, page.edits([page.range(2), page.range(5)]));
  assert.equal(output, 'const view = <main>\n  <Child\n    // value="hello"\n    onClick={() => console.log("hello")}\n  />\n  {/* <span /> */}\n</main>;');
  assert.equal(fixture(output).diagnostics().length, 0, 'mixed attribute and child comments remain valid TSX');
});

test('blank JSX lines stay blank and overlapping selections do not duplicate changes', () => {
  const text = 'const view = <>\n  \n  <span />\n</>;';
  const page = fixture(text);
  assert.deepEqual(page.edits([page.range(1)]), []);
  const one = page.edits([page.range(2)]);
  assert.deepEqual(page.edits([page.range(2), page.range(2)]), one);
});
