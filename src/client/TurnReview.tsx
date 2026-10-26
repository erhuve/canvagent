import { useEffect, useId, useRef, useState } from 'react';
import type { TurnReview } from '../shared/context';
import { api, ApiError, errorMessage } from './api';
import { Icon } from './icons';
import './TurnReview.css';

type ReviewDetail = { review: TurnReview; path?: string; diff?: string; binary?: boolean; restored?: boolean; truncated?: boolean };
type Props = { sessionId: string; reviews: TurnReview[]; onCanvasReview: (ids: string[]) => void; onRestored?: () => void };
const changed = (review: TurnReview) => review.files.length > 0 || review.canvasElementIds.length > 0;
const counts = (review: TurnReview) => [review.files.length ? `${review.files.length} file${review.files.length === 1 ? '' : 's'}` : '', review.canvasElementIds.length ? `${review.canvasElementIds.length} canvas object${review.canvasElementIds.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
const statusLabel = (status: TurnReview['status']) => ({ completed: 'Completed', interrupted: 'Interrupted', failed: 'Failed', unknown: 'Snapshot unavailable', running: 'Tracking changes…' })[status];
const lineClass = (line: string) => /^(@@|diff |index |---|\+\+\+|new file|deleted file|old mode|new mode)/.test(line) ? 'turn-diff-meta' : line.startsWith('+') ? 'turn-diff-add' : line.startsWith('-') ? 'turn-diff-remove' : '';

export function ConversationReview({ sessionId, reviews, onCanvasReview, onRestored }: Props) {
  const history = reviews.filter(review => review.status !== 'running' && (changed(review) || review.truncated || review.status === 'unknown')).slice(-20);
  const latest = history.at(-1);
  const running = reviews.some(review => review.status === 'running');
  const [open, setOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string>();
  const [path, setPath] = useState<string>();
  const [detail, setDetail] = useState<ReviewDetail>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoredNotice, setRestoredNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const requests = useRef(new Map<string, string>());
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const headingId = useId();
  const selected = history.find(review => review.id === reviewId) ?? latest;
  const file = selected?.files.find(file => file.path === path);
  const endpoint = selected ? `/api/sessions/${encodeURIComponent(sessionId)}/reviews/${encodeURIComponent(selected.id)}` : '';
  const selectionIdentity = useRef('');
  selectionIdentity.current = `${sessionId}:${selected?.id}:${path}`;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestVersion.current++; }; }, []);
  useEffect(() => { setOpen(false); setReviewId(undefined); setPath(undefined); setRestoring(false); setConfirmRestore(false); setRestoreError(''); setRestoredNotice(''); }, [sessionId]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    const version = ++requestVersion.current;
    if (!open || !selected) { setDetail(undefined); setLoading(false); return; }
    const abort = new AbortController();
    setLoading(true); setDetail(undefined); setError('');
    void api<ReviewDetail>(`${endpoint}${path ? `?path=${encodeURIComponent(path)}` : ''}`, undefined, { signal: abort.signal }).then(result => {
      if (version === requestVersion.current) setDetail(result);
    }).catch(error => {
      if (!abort.signal.aborted && version === requestVersion.current) setError(errorMessage(error));
    }).finally(() => { if (version === requestVersion.current) setLoading(false); });
    return () => abort.abort();
  }, [open, endpoint, path, refresh]);

  const chooseReview = (id: string) => {
    const review = history.find(review => review.id === id);
    if (!review) return;
    setReviewId(id); setPath(review.files[0]?.path); setDetail(undefined);
    setConfirmRestore(false); setRestoreError(''); setRestoredNotice('');
  };
  const chooseFile = (nextPath: string) => {
    setPath(nextPath); setDetail(undefined); setConfirmRestore(false); setRestoreError(''); setRestoredNotice('');
  };
  const show = () => {
    if (!latest) return;
    chooseReview(latest.id); setOpen(true);
  };
  const restore = async () => {
    if (!selected || !file || restoring || !detail || detail.restored) return;
    const key = `${sessionId}:${selected.id}:${file.path}`;
    let requestId = requests.current.get(key);
    if (!requestId) { requestId = crypto.randomUUID(); requests.current.set(key, requestId); }
    setRestoring(true); setRestoreError('');
    try {
      await api(`${endpoint}/restore`, { path: file.path, requestId });
      if (!mounted.current || currentSession.current !== sessionId) return;
      if (selectionIdentity.current !== key) { onRestored?.(); return; }
      setConfirmRestore(false);
      setRestoredNotice(file.status === 'added' ? 'File removed; it did not exist before this turn.' : 'File restored to its contents before this turn.');
      setDetail(previous => previous ? { ...previous, restored: true } : previous);
      setRefresh(value => value + 1);
      onRestored?.();
    } catch (error) {
      if (mounted.current && currentSession.current === sessionId && selectionIdentity.current === key) setRestoreError(error instanceof ApiError && error.status === 409 ? `Restore was not applied. Later edits are preserved. ${errorMessage(error)}` : errorMessage(error));
    } finally { if (mounted.current && currentSession.current === sessionId) setRestoring(false); }
  };

  if (!latest && !running) return null;
  return <section className="conversation-review" aria-label="Conversation changes">
    {running && <div className="turn-review-tracking" role="status"><span className="working-spinner" />Tracking changes…</div>}
    {latest && <button className="turn-review-summary" type="button" disabled={restoring} onClick={show} aria-label="Review changes" aria-haspopup="dialog"><Icon name="compose" size={15} /><span><strong>Review changes</strong><small>{counts(latest) || statusLabel(latest.status)}</small></span><Icon name="arrow-right" size={15} /></button>}
    <dialog className="turn-review-dialog" ref={dialog} aria-labelledby={headingId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header className="turn-review-heading"><div><h2 id={headingId}>Review changes</h2><p>Changes observed during this turn. Other editors or agents may also have contributed.</p></div><button type="button" className="icon-button" aria-label="Close change review" onClick={() => setOpen(false)}><Icon name="close" size={17} /></button></header>
      {selected && <>
        <div className="turn-review-controls"><span className="turn-review-status">{statusLabel(selected.status)}{counts(selected) ? ` · ${counts(selected)}` : ''}</span>{history.length > 1 && <label><span>Turn</span><select aria-label="Choose turn to review" disabled={restoring} value={selected.id} onChange={event => chooseReview(event.target.value)}>{[...history].reverse().map(review => <option value={review.id} key={review.id}>{new Date(review.createdAt).toLocaleString()} · {statusLabel(review.status)} · {counts(review) || 'No captured changes'}</option>)}</select></label>}</div>
        {(selected.truncated || detail?.truncated) && <p className="turn-review-notice" role="status">This review contains bounded snapshots. Some files, content, or changes may be omitted.</p>}
        {selected.status === 'unknown' && <p className="turn-review-notice">The snapshot for this turn is unavailable. The app may have restarted before it finished recording changes.</p>}
        <div className="turn-review-layout">
          <nav className="turn-review-files" aria-label="Files changed during turn">{selected.files.map(file => <button key={file.path} type="button" disabled={restoring} aria-label={`Review file: ${file.path}`} aria-pressed={path === file.path} onClick={() => chooseFile(file.path)}><Icon name="file" size={14} /><span>{file.path}</span><small>{file.status === 'added' ? 'Added' : file.status === 'deleted' ? 'Deleted' : 'Modified'}</small></button>)}{!!selected.canvasElementIds.length && <button type="button" className="turn-review-canvas" disabled={restoring} onClick={() => { onCanvasReview(selected.canvasElementIds); setOpen(false); }}><Icon name="board" size={14} /><span>Show canvas changes</span><small>{selected.canvasElementIds.length}</small></button>}{!selected.files.length && !selected.canvasElementIds.length && <p>No changes were captured for this turn.</p>}</nav>
          <div className="turn-review-content">
            {file && <div className="turn-review-file-heading"><strong>{file.path}</strong><span>Saved comparison · before → after turn</span></div>}
            {loading ? <p className="turn-review-empty" role="status">Loading saved changes…</p> : error ? <p className="turn-review-error" role="alert">{error}</p> : !file ? <p className="turn-review-empty">{selected.canvasElementIds.length ? 'Show canvas changes to reveal the affected objects on the board.' : 'Choose a captured file to review its saved changes.'}</p> : detail?.binary ? <p className="turn-review-empty">A text diff is unavailable for this binary file.</p> : detail?.diff ? <pre className="turn-review-diff" tabIndex={0} aria-label={`Saved diff for ${file.path}`}><code>{detail.diff.replace(/\n$/, '').split('\n').map((line, index) => <span className={lineClass(line)} key={index}>{line || '\u00a0'}</span>)}</code></pre> : <p className="turn-review-empty">No text differences in this saved comparison.</p>}
            {file && detail && !loading && !error && !detail.binary && selected.status !== 'unknown' && <div className="turn-review-restore">
              {detail.restored ? <p className="turn-review-restored" role="status"><Icon name="check" size={14} />This file has been restored.</p> : confirmRestore ? <div className="turn-review-confirm"><p>{file.status === 'added' ? `Remove ${file.path}, which was added during this turn?` : file.status === 'deleted' ? `Restore ${file.path} from the snapshot before this turn?` : `Replace ${file.path} with its contents before this turn?`}<small>This applies only if the file still matches this turn’s ending snapshot.</small></p><div><button type="button" disabled={restoring} onClick={() => { setConfirmRestore(false); setRestoreError(''); }}>Cancel restore</button><button type="button" className="turn-restore-confirm" disabled={restoring} onClick={() => void restore()}>{restoring ? 'Restoring…' : 'Confirm restore'}</button></div></div> : <button type="button" onClick={() => { setConfirmRestore(true); setRestoredNotice(''); setRestoreError(''); }}><Icon name="undo" size={14} />Restore file before this turn</button>}
              {restoreError && <p className="turn-review-error" role="alert">{restoreError}</p>}{restoredNotice && <p className="turn-review-restored" role="status">{restoredNotice}</p>}
            </div>}
          </div>
        </div>
      </>}
    </dialog>
  </section>;
}
