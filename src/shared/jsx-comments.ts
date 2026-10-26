import type * as TypeScript from 'typescript';

export type CommentRange = { pos: number; end: number };
export type CommentTextChange = { span: { start: number; length: number }; newText: string };
type Compiler = typeof TypeScript;
type CommentService = {
  toggleMultilineComment(fileName: string, range: CommentRange, insertComment?: boolean, insideJsx?: boolean): readonly CommentTextChange[];
};
type Region = { start: number; end: number; jsx: boolean };

// Reuse the worker's existing parser and syntax tree. Monaco's small Monarch
// tokenizer has no JSX child state, and TS 5.9's own JSX predicate misses fragments.
function childRegions(ts: Compiler, source: TypeScript.SourceFile): Region[] {
  const regions: Region[] = [];
  const visit = (node: TypeScript.Node) => {
    if (ts.isJsxElement(node)) regions.push({ start: node.openingElement.end, end: node.closingElement.getStart(source), jsx: true });
    else if (ts.isJsxFragment(node)) regions.push({ start: node.openingFragment.end, end: node.closingFragment.getStart(source), jsx: true });
    else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) regions.push({ start: node.getStart(source) + 1, end: node.end, jsx: false });
    else if (ts.isJsxExpression(node) && node.expression) regions.push({ start: node.getStart(source) + 1, end: node.end - 1, jsx: false });
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) regions.push({ start: node.getStart(source), end: node.end, jsx: false });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return regions;
}

function inJsx(regions: Region[], position: number) {
  let narrowest: Region | undefined;
  for (const region of regions) {
    if (region.start <= position && position < region.end && (!narrowest || region.end - region.start < narrowest.end - narrowest.start)) narrowest = region;
  }
  return !!narrowest?.jsx;
}

function delimiterSpaces(edit: CommentTextChange, text: string, insertSpace: boolean): CommentTextChange {
  if (edit.newText === '{/*') return { ...edit, newText: insertSpace ? '{/* ' : '{/*' };
  if (edit.newText === '*/}') return { ...edit, newText: insertSpace ? ' */}' : '*/}' };
  if (edit.newText || edit.span.length !== 3 || !insertSpace) return edit;
  const { start, length } = edit.span;
  const token = text.slice(start, start + length);
  if (token === '{/*' && text[start + length] === ' ') return { ...edit, span: { start, length: length + 1 } };
  if (token === '*/}' && text[start - 1] === ' ' && /\S/.test(text.slice(text.lastIndexOf('\n', start - 1) + 1, start - 1))) return { ...edit, span: { start: start - 1, length: length + 1 } };
  return edit;
}

export function jsxCommentEdits(
  ts: Compiler, service: CommentService, source: TypeScript.SourceFile,
  ranges: readonly CommentRange[], insertSpace: boolean,
): CommentTextChange[] | null {
  const text = source.text;
  const starts = source.getLineStarts();
  const regions = childRegions(ts, source);
  const normalized = ranges.filter(range => Number.isFinite(range.pos) && Number.isFinite(range.end)).map(range => {
    const pos = Math.max(0, Math.min(text.length, Math.min(range.pos, range.end)));
    const end = Math.max(pos, Math.min(text.length, Math.max(range.pos, range.end)));
    const first = source.getLineAndCharacterOfPosition(pos).line;
    let last = source.getLineAndCharacterOfPosition(end).line;
    if (last > first && starts[last] === end) last--;
    return { first, last };
  }).sort((a, b) => a.first - b.first || a.last - b.last);
  const groups: { first: number; last: number }[] = [];
  for (const range of normalized) {
    const previous = groups[groups.length - 1];
    if (previous && range.first <= previous.last) previous.last = Math.max(previous.last, range.last);
    else groups.push({ ...range });
  }
  const selections = groups.map(range => {
    const line = text.slice(starts[range.first], source.getLineEndOfPosition(starts[range.first]));
    const position = starts[range.first] + (line.search(/\S/) < 0 ? line.length : line.search(/\S/));
    return { ...range, jsx: inJsx(regions, position) };
  });
  if (!selections.some(selection => selection.jsx)) return null;

  const edits: CommentTextChange[] = [];
  for (const selection of selections) {
    const lines: { start: number; end: number; content: string; indent: number }[] = [];
    for (let line = selection.first; line <= selection.last; line++) {
      const start = starts[line];
      const end = source.getLineEndOfPosition(start);
      const content = text.slice(start, end);
      const indent = content.search(/\S/);
      if (indent >= 0) lines.push({ start, end, content, indent });
    }
    if (!lines.length) continue;
    if (selection.jsx) {
      // The existing LS handles comments already inside JSX, including removing
      // a multiline comment. Its fourth argument supplies the missing fragment
      // context; no source text or tree is rewritten to coerce the parser.
      const changes = service.toggleMultilineComment(source.fileName, { pos: lines[0].start + lines[0].indent, end: lines[lines.length - 1].end }, undefined, true);
      edits.push(...changes.map(edit => delimiterSpaces(edit, text, insertSpace)));
    } else {
      const remove = lines.every(line => line.content.slice(line.indent).startsWith('//'));
      const commonIndent = Math.min(...lines.map(line => line.indent));
      for (const line of lines) {
        const start = line.start + (remove ? line.indent : commonIndent);
        edits.push(remove ? { span: { start, length: 2 + (insertSpace && text[start + 2] === ' ' ? 1 : 0) }, newText: '' } : { span: { start, length: 0 }, newText: insertSpace ? '// ' : '//' });
      }
    }
  }
  // A single padding space in an empty {/* */} belongs to both delimiters.
  // Coalesce their removals so Monaco never receives overlapping edit ranges.
  const result: CommentTextChange[] = [];
  for (const edit of edits.sort((a, b) => a.span.start - b.span.start)) {
    const previous = result[result.length - 1];
    if (previous && !previous.newText && !edit.newText && edit.span.start <= previous.span.start + previous.span.length) {
      previous.span.length = Math.max(previous.span.start + previous.span.length, edit.span.start + edit.span.length) - previous.span.start;
    } else result.push({ ...edit, span: { ...edit.span } });
  }
  return result;
}
