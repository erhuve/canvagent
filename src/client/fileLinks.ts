export type FileLocation = { path: string; line?: number; column?: number };

// Markdown paths are relative to the project, not the page's HTTP URL.
export function resolveFileLink(href: string, workspace?: string): FileLocation | undefined {
  if (!href || /^[#?]/.test(href) || href.startsWith('//')) return;
  let path = href.trim();
  const protocol = path.match(/^([a-z][a-z\d+.-]*):/i)?.[1];
  // A bare filename with an extension may be followed by :line. Other
  // protocol-prefixed destinations are URLs, even when they end in digits.
  if (protocol && protocol.toLowerCase() !== 'file' && !protocol.includes('.')) return;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== 'localhost' || url.search) return;
      path = url.pathname + url.hash;
    } catch { return; }
  }
  const position = path.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)$/);
  const line = position ? Number(position[1] ?? position[3]) : undefined;
  const column = position?.[2] || position?.[4] ? Number(position[2] ?? position[4]) : undefined;
  if (position) path = path.slice(0, position.index);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.includes('?')) return;
  path = path.split('#')[0];
  try { path = decodeURIComponent(path); } catch { return; }
  if (/[\x00-\x1f\\]/.test(path) || path.startsWith('//')) return;
  if (path.startsWith('/')) {
    const root = workspace?.replace(/\/+$/, '');
    if (!root || !path.startsWith(`${root}/`)) return;
    path = path.slice(root.length + 1);
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return; parts.pop(); }
    else parts.push(part);
  }
  if (!parts.length || line !== undefined && (!Number.isSafeInteger(line) || line < 1)
    || column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return;
  return { path: parts.join('/'), ...(line ? { line } : {}), ...(column ? { column } : {}) };
}
