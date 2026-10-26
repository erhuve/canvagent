import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';
import { Icon } from './icons';
import './GitPanel.css';

type ChangedFile = { path: string; status: string; staged: boolean; unstaged: boolean; untracked: boolean; originalPath?: string };
type Changes = { available: boolean; branch?: string; files: ChangedFile[] };
type Diff = { path: string; diff: string; binary?: boolean; truncated?: boolean };
type Selection = { path: string; staged: boolean };
const visiblePath = (path: string) => /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;
const describeStatus = (file: ChangedFile, staged: boolean) => {
  if (file.untracked) return 'Untracked';
  const code = file.status[staged ? 0 : 1];
  return ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', T: 'Type changed' } as Record<string, string>)[code] ?? 'Changed';
};
const lineClass = (line: string) => /^(@@|diff |index |---|\+\+\+|new file|deleted file|old mode|new mode)/.test(line) ? 'git-diff-meta' : line.startsWith('+') ? 'git-diff-add' : line.startsWith('-') ? 'git-diff-remove' : '';

export function GitPanel({ active, projectKey }: { active: boolean; projectKey: string }) {
  const [changes, setChanges] = useState<Changes>();
  const [selection, setSelection] = useState<Selection | undefined>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`canvagent:git-selection:${projectKey}`) ?? 'null');
      if (typeof saved?.path === 'string' && typeof saved?.staged === 'boolean') return saved;
    } catch { /* Optional view preference. */ }
    return undefined;
  });
  const [diff, setDiff] = useState<Diff>();
  const [refreshing, setRefreshing] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState('');
  const [diffError, setDiffError] = useState('');
  const [revision, setRevision] = useState(0);
  const refreshRequest = useRef(0);
  const diffRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    setRefreshing(true); setError('');
    try {
      const result = await api<Changes>('/api/git/status');
      if (request !== refreshRequest.current) return;
      setChanges(result);
      setSelection(previous => {
        const retained = result.files.find(file => file.path === previous?.path && (previous.staged ? file.staged : file.unstaged || file.untracked));
        if (retained) return previous;
        const next = result.files.find(file => file.unstaged || file.untracked) ?? result.files[0];
        return next ? { path: next.path, staged: !(next.unstaged || next.untracked) } : undefined;
      });
      setRevision(previous => previous + 1);
    } catch (error) { if (request === refreshRequest.current) setError(errorMessage(error)); }
    finally { if (request === refreshRequest.current) setRefreshing(false); }
  }, []);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  useEffect(() => () => { refreshRequest.current++; diffRequest.current++; }, []);
  useEffect(() => {
    try {
      if (selection) sessionStorage.setItem(`canvagent:git-selection:${projectKey}`, JSON.stringify(selection));
      else sessionStorage.removeItem(`canvagent:git-selection:${projectKey}`);
    } catch { /* Optional view preference. */ }
  }, [selection, projectKey]);
  useEffect(() => {
    const request = ++diffRequest.current;
    if (!selection || !changes?.available) { setDiff(undefined); setDiffError(''); setLoadingDiff(false); return; }
    const controller = new AbortController();
    setLoadingDiff(true); setDiffError(''); setDiff(undefined);
    void api<Diff>(`/api/git/diff?path=${encodeURIComponent(selection.path)}&staged=${selection.staged}`, undefined, { signal: controller.signal }).then(result => {
      if (request === diffRequest.current) setDiff(result);
    }).catch(error => { if (request === diffRequest.current && !controller.signal.aborted) setDiffError(errorMessage(error)); })
      .finally(() => { if (request === diffRequest.current) setLoadingDiff(false); });
    return () => controller.abort();
  }, [selection?.path, selection?.staged, changes?.available, revision]);

  const group = (label: string, staged: boolean) => {
    const files = changes?.files.filter(file => staged ? file.staged : file.unstaged || file.untracked) ?? [];
    if (!files.length) return null;
    return <section className="git-file-group" aria-label={label}>
      <h3>{label}<span>{files.length}</span></h3>
      {files.map(file => <button key={file.path} className={`git-file-row ${selection?.path === file.path && selection.staged === staged ? 'selected' : ''}`} aria-pressed={selection?.path === file.path && selection.staged === staged} title={file.originalPath ? `${visiblePath(file.originalPath)} → ${visiblePath(file.path)}` : visiblePath(file.path)} onClick={() => setSelection({ path: file.path, staged })}>
        <Icon name="file" size={14} /><span className="git-file-path">{visiblePath(file.path)}{file.originalPath && <small>from {visiblePath(file.originalPath)}</small>}</span><span className={`git-file-status ${file.untracked ? 'untracked' : ''}`}>{describeStatus(file, staged)}</span>
      </button>)}
    </section>;
  };
  return <section className="git-panel" aria-label="Source control changes">
    <header className="git-toolbar"><div><strong>Changes</strong>{changes?.branch && <span className="git-branch" title={changes.branch}>{changes.branch}</span>}</div><span className="git-review-label">Review</span><button onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh changes" title="Refresh changes"><Icon name="reconnect" size={15} />{refreshing ? 'Refreshing…' : 'Refresh'}</button></header>
    {error && <div className="git-error" role="alert">{error}</div>}
    {!changes && !error && <div className="git-empty" role="status">Reading project changes…</div>}
    {changes && !changes.available && <div className="git-empty"><Icon name="folder" size={26} /><strong>No Git repository</strong><p>Open a project with a Git working tree to review its changes here.</p></div>}
    {changes?.available && !changes.files.length && <div className="git-empty"><Icon name="check" size={26} /><strong>Working tree clean</strong><p>Saved file changes will appear here. Refresh after the agent edits your project.</p></div>}
    {changes?.available && !!changes.files.length && <div className="git-review-layout">
      <nav className="git-file-list" aria-label="Changed files">{group('Working tree', false)}{group('Staged', true)}</nav>
      <div className="git-diff-view"><div className="git-diff-title"><span title={selection?.path}>{selection ? visiblePath(selection.path) : 'Choose a file'}</span>{selection && <small>{selection.staged ? 'Staged · HEAD → index' : 'Working tree'}</small>}</div>
        {loadingDiff ? <div className="git-empty" role="status">Loading diff…</div> : diffError ? <div className="git-error" role="alert">{diffError}</div> : diff?.binary ? <div className="git-empty"><Icon name="file" size={26} /><strong>Binary file changed</strong><p>A text diff is unavailable for this file.</p></div> : diff?.diff ? <pre className="git-diff" tabIndex={0} aria-label={`Diff for ${selection?.path}`}><code>{diff.diff.replace(/\n$/, '').split('\n').map((line, index) => <span className={lineClass(line)} key={index}>{line || '\u00a0'}</span>)}</code></pre> : <div className="git-empty">No text changes in this comparison.</div>}
        {diff?.truncated && <div className="git-truncated" role="status">This diff is large. Only the beginning is shown.</div>}
      </div>
    </div>}
  </section>;
}
