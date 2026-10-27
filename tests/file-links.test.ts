import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveFileLink } from '../src/client/fileLinks';

test('Markdown file links resolve project paths and source locations', () => {
  const root = '/Users/me/project';
  for (const href of ['content/blog/tbd.md', './content/blog/tbd.md', `${root}/content/blog/tbd.md`, `file://${root}/content/blog/tbd.md`]) {
    assert.deepEqual(resolveFileLink(href, root), { path: 'content/blog/tbd.md' });
  }
  assert.deepEqual(resolveFileLink('src/example.ts:12:3', root), { path: 'src/example.ts', line: 12, column: 3 });
  assert.deepEqual(resolveFileLink(`${root}/src/example.ts#L12-L20`, root), { path: 'src/example.ts', line: 12 });
  assert.deepEqual(resolveFileLink('notes/a%20draft.md#L2C5', root), { path: 'notes/a draft.md', line: 2, column: 5 });
  assert.deepEqual(resolveFileLink('src/../README.md#intro', root), { path: 'README.md' });
});

test('web URLs, page anchors and paths outside the workspace are not file links', () => {
  for (const href of ['javascript:123', ' javascript:123', 'data:123', 'custom:123', 'https://example.com:123']) {
    assert.equal(resolveFileLink(href, '/Users/me/project'), undefined, href);
  }
  for (const href of ['', '#intro', '?q=search', 'https://example.com/a.md#L2', 'mailto:me@example.com', 'javascript:alert(1)', '//example.com/a.md', '../secret', '%2e%2e/secret', '/Users/me/project-other/a.md', '/etc/passwd', 'file://other-host/Users/me/project/a.md', 'src/file.ts:0', 'src/file.ts:2:0', 'bad%00.md', 'bad%ZZ.md']) {
    assert.equal(resolveFileLink(href, '/Users/me/project'), undefined, href);
  }
});
