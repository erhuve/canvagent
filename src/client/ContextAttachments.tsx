import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { ContextAttachment, ContextReference, ContextSuggestion } from '../shared/context';
import { api, apiPath, errorMessage, projectBasePath } from './api';
import { Icon } from './icons';
import './ContextAttachments.css';

const MAX_ATTACHMENTS = 12;
const MAX_IMAGES = 6;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
type Pending = { id: string; label: string; kind?: ContextAttachment['kind']; image?: boolean; error?: string };
type Draft = { attachments: ContextAttachment[]; pending: Pending[]; error?: string; loading?: boolean };
const emptyDraft = (): Draft => ({ attachments: [], pending: [] });
type SavedReference = Pick<ContextAttachment, 'id' | 'label' | 'kind'>;

function draftKey(scope: string) { return `canvagent:context:${scope}`; }
function savedReferences(scope: string): SavedReference[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(draftKey(scope)) ?? '[]');
    return Array.isArray(value) ? value.filter(item => item && typeof item.id === 'string' && typeof item.label === 'string').slice(0, MAX_ATTACHMENTS) : [];
  } catch { return []; }
}
function persist(scope: string, attachments: SavedReference[]) {
  try {
    // Content and image bytes live on the server. Storage contains references only.
    if (attachments.length) sessionStorage.setItem(draftKey(scope), JSON.stringify(attachments.map(({ id, kind, label }) => ({ id, kind, label }))));
    else sessionStorage.removeItem(draftKey(scope));
  } catch { /* Draft storage is optional. */ }
}
function imageData(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(new DOMException('Upload canceled', 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    reader.onload = () => { cleanup(); resolve(String(reader.result)); };
    reader.onerror = () => { cleanup(); reject(new Error(`Could not read ${file.name}.`)); };
    reader.onabort = cleanup;
    reader.readAsDataURL(file);
  });
}

export function useDraftAttachments(workspace: string | undefined, sessionId: string | undefined) {
  const scope = `${projectBasePath || workspace || 'workspace'}:${sessionId || 'new'}`;
  const drafts = useRef(new Map<string, Draft>());
  const uploads = useRef(new Map<string, AbortController>());
  const [, render] = useState(0);
  const mounted = useRef(true);
  const notify = () => { if (mounted.current) render(value => value + 1); };
  const get = (key = scope) => drafts.current.get(key) ?? emptyDraft();
  const update = (key: string, change: (draft: Draft) => Draft) => {
    const next = change(get(key));
    drafts.current.set(key, next);
    const restoring = next.pending.filter(item => item.id.startsWith('ctx_')).map(item => ({ id: item.id, label: item.label, kind: item.kind ?? (item.image ? 'image' as const : 'file' as const) }));
    persist(key, [...next.attachments, ...restoring]);
    notify();
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const upload of uploads.current.values()) upload.abort(); };
  }, []);
  useEffect(() => {
    if (!sessionId || drafts.current.has(scope)) return;
    const saved = savedReferences(scope);
    if (!saved.length) { drafts.current.set(scope, emptyDraft()); notify(); return; }
    const savedIds = new Set(saved.map(item => item.id));
    const pending = saved.map(item => ({ id: item.id, label: item.label, kind: item.kind, image: item.kind === 'image' }));
    drafts.current.set(scope, { attachments: [], pending, loading: true });
    notify();
    void api<{ attachments: ContextAttachment[] }>(`/api/context/attachments?ids=${encodeURIComponent(saved.map(item => item.id).join(','))}`).then(({ attachments }) => {
      update(scope, draft => {
        const wanted = new Set(draft.pending.filter(item => savedIds.has(item.id)).map(item => item.id));
        const restored = attachments.filter(item => wanted.has(item.id));
        const pending = draft.pending.filter(item => !restored.some(attachment => attachment.id === item.id)).map(item => savedIds.has(item.id) ? { ...item, error: 'This context is unavailable. Remove it and attach it again.' } : item);
        return { ...draft, attachments: [...draft.attachments, ...restored], loading: false, pending };
      });
    }).catch(error => {
      // Keep the saved IDs for another reload if the server is temporarily unavailable.
      const draft = get(scope);
      const failed = draft.pending.filter(item => savedIds.has(item.id)).map(item => ({ ...item, error: errorMessage(error) }));
      drafts.current.set(scope, { ...draft, pending: [...draft.pending.filter(item => !savedIds.has(item.id)), ...failed], error: failed.length ? 'Could not restore attached context. Remove it and attach it again.' : undefined, loading: failed.length > 0 });
      notify();
    });
  }, [scope, sessionId]);

  const begin = (label: string, image = false) => {
    const draft = get();
    if (draft.loading) { update(scope, value => ({ ...value, error: 'Wait for your saved context to finish loading.' })); return; }
    if (draft.attachments.length + draft.pending.length >= MAX_ATTACHMENTS) { update(scope, value => ({ ...value, error: `You can attach up to ${MAX_ATTACHMENTS} items per message.` })); return; }
    if (image && draft.attachments.filter(item => item.kind === 'image').length + draft.pending.filter(item => item.image).length >= MAX_IMAGES) { update(scope, value => ({ ...value, error: `You can attach up to ${MAX_IMAGES} images per message.` })); return; }
    const id = crypto.randomUUID();
    const controller = new AbortController();
    uploads.current.set(id, controller);
    update(scope, value => ({ ...value, error: undefined, pending: [...value.pending, { id, label, image }] }));
    return { id, controller };
  };
  const finish = async (id: string, promise: Promise<ContextAttachment>) => {
    const target = scope;
    try {
      const attachment = await promise;
      if (!uploads.current.has(id)) return;
      update(target, draft => ({ ...draft, pending: draft.pending.filter(item => item.id !== id), attachments: [...draft.attachments, attachment] }));
    } catch (error) {
      if (!uploads.current.has(id)) return;
      update(target, draft => ({ ...draft, pending: draft.pending.map(item => item.id === id ? { ...item, error: errorMessage(error) } : item) }));
    } finally { uploads.current.delete(id); }
  };
  const addReference = (reference: ContextReference, label = reference.kind === 'file' || reference.kind === 'folder' ? reference.path : reference.kind === 'canvas' ? 'Canvas selection' : reference.kind === 'conversation' ? 'Conversation' : 'Artifact', imageSupported = true) => {
    const image = reference.kind === 'image' || reference.kind === 'file' && /\.(png|jpe?g|webp|gif)$/i.test(reference.path);
    if (image && !imageSupported) { update(scope, draft => ({ ...draft, error: 'This agent does not accept images. Choose an agent with image support to attach one.' })); return false; }
    const upload = begin(label, image);
    if (!upload) return false;
    void finish(upload.id, api<ContextAttachment>('/api/context/attachments', { reference }, { signal: upload.controller.signal }));
    return true;
  };
  const addImages = (files: File[], supported: boolean) => {
    if (!supported) { update(scope, draft => ({ ...draft, error: 'This agent does not accept images. Choose an agent with image support to attach one.' })); return; }
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) { update(scope, draft => ({ ...draft, error: 'Use a PNG, JPEG, WebP, or GIF image.' })); continue; }
      if (!file.size || file.size > MAX_IMAGE_SIZE) { update(scope, draft => ({ ...draft, error: `${file.name || 'Image'} must be between 1 byte and 10 MB.` })); continue; }
      const upload = begin(file.name || 'Pasted image', true);
      if (!upload) continue;
      void finish(upload.id, imageData(file, upload.controller.signal).then(dataUrl => api<ContextAttachment>('/api/context/images', { name: file.name || 'Pasted image', dataUrl }, { signal: upload.controller.signal })));
    }
  };
  const remove = (id: string) => {
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
    update(scope, draft => {
      const pending = draft.pending.filter(item => item.id !== id);
      return { ...draft, attachments: draft.attachments.filter(item => item.id !== id), pending, loading: draft.loading && pending.length > 0, error: undefined };
    });
  };
  const accepted = (ids: string[], targetScope = scope) => update(targetScope, draft => ({ ...draft, attachments: draft.attachments.filter(item => !ids.includes(item.id)) }));
  const draft = get();
  return { ...draft, scope, addReference, addImages, remove, accepted, blocked: !!draft.loading || draft.pending.length > 0 };
}
export type DraftAttachments = ReturnType<typeof useDraftAttachments>;

function contextIcon(kind: ContextAttachment['kind']) {
  return kind === 'image' ? 'image' : kind === 'canvas' ? 'board' : kind === 'conversation' ? 'chat' : kind === 'folder' ? 'folder' : 'file';
}
export function ContextAttachmentList({ attachments, onRemove, pending = [], transcript = false }: { attachments: ContextAttachment[]; onRemove?: (id: string) => void; pending?: Pending[]; transcript?: boolean }) {
  const [previewId, setPreviewId] = useState<string>();
  const preview = attachments.find(item => item.id === previewId);
  if (!attachments.length && !pending.length) return null;
  return <div className={`context-attachments ${transcript ? 'transcript-attachments' : ''}`}>
    <div className="context-chips" aria-label={transcript ? 'Message attachments' : 'Attached context'}>
      {attachments.map(item => <div className={`context-chip context-kind-${item.kind}`} key={item.id}>
        <button type="button" className="context-chip-preview" aria-label={`Preview context: ${item.label}`} aria-expanded={previewId === item.id} onClick={() => setPreviewId(previewId === item.id ? undefined : item.id)} title={item.path ?? item.label}>
          {item.kind === 'image' && item.imageId ? <img src={apiPath(`/api/context/images/${encodeURIComponent(item.imageId)}`)} alt="" /> : <Icon name={contextIcon(item.kind)} size={13} />}
          <span>{item.label}</span>{item.truncated && <span className="context-truncated" title="Long content was truncated">…</span>}
        </button>
        {onRemove && <button type="button" className="context-chip-remove" aria-label={`Remove context: ${item.label}`} title="Remove context" onClick={() => onRemove(item.id)}><Icon name="close" size={12} /></button>}
      </div>)}
      {pending.map(item => <div className={`context-chip context-pending ${item.error ? 'context-failed' : ''}`} key={item.id} title={item.error}>
        <span className="context-pending-label" role="status">{item.error ? <Icon name="warning" size={13} /> : <span className="working-spinner" />}<span>{item.label}</span><small>{item.error ? 'Failed' : 'Attaching…'}</small></span>
        {onRemove && <button type="button" className="context-chip-remove" aria-label={`Remove context: ${item.label}`} onClick={() => onRemove(item.id)}><Icon name="close" size={12} /></button>}
        {item.error && <span className="context-item-error" role="alert">{item.error}</span>}
      </div>)}
    </div>
    {preview && <section className="context-preview" aria-label={`Context preview: ${preview.label}`}>
      <div className="context-preview-heading"><strong>{preview.label}</strong><button type="button" className="icon-button" aria-label="Close context preview" onClick={() => setPreviewId(undefined)}><Icon name="close" size={13} /></button></div>
      <p>{transcript ? 'Context sent with this message' : 'What the agent receives'}{preview.revision !== undefined ? ` · Snapshot ${String(preview.revision).slice(0, 12)}` : ''}{preview.truncated ? ' · Truncated' : ''}</p>
      {preview.kind === 'image' && preview.imageId ? <a className="context-image-preview" href={apiPath(`/api/context/images/${encodeURIComponent(preview.imageId)}`)} target="_blank" rel="noreferrer"><img src={apiPath(`/api/context/images/${encodeURIComponent(preview.imageId)}`)} alt={preview.label} />{preview.width && preview.height ? <span>{preview.width} × {preview.height}</span> : null}</a> : <pre>{preview.text || preview.path || preview.label}</pre>}
    </section>}
  </div>;
}

function mentionAt(text: string, caret: number) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { query: match[1]!, start: caret - match[1]!.length - 1, end: caret } : undefined;
}

export function ContextComposer({ controller, workspace, sessionId, inputRef, text, setText, imageSupported, disabled, children }: {
  controller: DraftAttachments; workspace?: string; sessionId?: string; inputRef: RefObject<HTMLTextAreaElement>;
  text: string; setText: (text: string) => void; imageSupported: boolean; disabled: boolean;
  children: (handlers: { onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void; onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void; onSelect: () => void; 'aria-controls'?: string; 'aria-expanded': boolean; 'aria-activedescendant'?: string }) => ReactNode;
}) {
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [mention, setMention] = useState<ReturnType<typeof mentionAt>>();
  const [items, setItems] = useState<ContextSuggestion[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const open = picker || !!mention;
  const search = picker ? query : mention?.query ?? '';
  const close = () => { setPicker(false); setMention(undefined); setError(''); };
  useEffect(() => { close(); }, [workspace, sessionId]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true); setItems([]); setError(''); setSelected(0);
    const timer = setTimeout(() => {
      void api<{ items: ContextSuggestion[] }>(`/api/context/suggestions?query=${encodeURIComponent(search)}`, undefined, { signal: abort.signal }).then(result => {
        if (!abort.signal.aborted) { setItems(result.items); setLoading(false); }
      }).catch(error => { if (!abort.signal.aborted) { setError(errorMessage(error)); setLoading(false); } });
    }, 120);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [open, search, workspace, sessionId]);
  useEffect(() => {
    if (!open) return;
    if (picker) queryInput.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, picker]);
  useEffect(() => {
    const attach = (event: Event) => {
      const detail = (event as CustomEvent<ContextReference | { reference: ContextReference; projectWorkspace?: string; sessionId?: string }>).detail;
      if (!detail || disabled) return;
      const wrapped = 'reference' in detail ? detail : undefined;
      const eventProject = wrapped?.projectWorkspace?.replace(/\/$/, '');
      if (eventProject && eventProject !== workspace?.replace(/\/$/, '') && eventProject !== projectBasePath || wrapped?.sessionId && wrapped.sessionId !== sessionId) return;
      const reference = wrapped?.reference ?? detail as ContextReference;
      controller.addReference(reference, undefined, imageSupported);
      inputRef.current?.focus();
    };
    window.addEventListener('canvagent:attach-context', attach);
    return () => window.removeEventListener('canvagent:attach-context', attach);
  }, [controller, workspace, sessionId, disabled, imageSupported]);

  const choose = (item: ContextSuggestion) => {
    if (!controller.addReference(item.reference, item.label, imageSupported)) return;
    if (mention) {
      const label = /\s/.test(item.label) ? `"${item.label.replaceAll('"', '')}"` : item.label;
      const inserted = `@${label} `;
      const next = text.slice(0, mention.start) + inserted + text.slice(mention.end);
      const caret = mention.start + inserted.length;
      setText(next);
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(caret, caret); });
    } else inputRef.current?.focus();
    close();
  };
  const keys = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); inputRef.current?.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(index => items.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length : 0); }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (items[selected]) choose(items[selected]!); }
  };
  const updateMention = () => {
    const input = inputRef.current;
    if (input && !picker) setMention(mentionAt(input.value, input.selectionStart));
  };
  const pasted = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = [...event.clipboardData.files];
    if (!files.length || disabled) return;
    event.preventDefault();
    controller.addImages(files, imageSupported);
  };
  const dropped = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    if (!disabled) controller.addImages([...event.dataTransfer.files], imageSupported);
  };
  return <div className={`context-composer ${dragging ? 'context-dragging' : ''}`} ref={root} onPaste={pasted} onDrop={dropped}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = disabled || !imageSupported ? 'none' : 'copy'; setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}>
    <div className="context-composer-actions">
      <button type="button" className="context-add-button" aria-label="Add context" aria-expanded={picker} aria-controls={open ? listId : undefined} disabled={disabled || controller.blocked} onClick={() => { setMention(undefined); setQuery(''); setPicker(!picker); }}><Icon name="plus" size={14} /><span>Add context</span><kbd>@</kbd></button>
      <button type="button" className="context-add-button context-image-button" aria-label="Attach images" disabled={disabled || !imageSupported || controller.blocked} title={imageSupported ? 'Attach images, or paste / drop them here' : 'This agent does not accept images'} onClick={() => imageInput.current?.click()}><Icon name="image" size={15} /><span>Image</span></button>
      <input ref={imageInput} className="context-file-input" type="file" aria-label="Choose images" multiple accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled || !imageSupported} onChange={event => { controller.addImages([...event.target.files ?? []], imageSupported); event.target.value = ''; inputRef.current?.focus(); }} />
    </div>
    <ContextAttachmentList attachments={controller.attachments} pending={controller.pending} onRemove={controller.remove} />
    {controller.error && <div className="context-error" role="alert"><Icon name="warning" size={13} />{controller.error}</div>}
    {!imageSupported && controller.attachments.some(item => item.kind === 'image') && <div className="context-error" role="alert">This agent does not accept images. Choose an agent with image support or remove the image.</div>}
    {open && <div className={`context-picker ${picker ? 'context-picker-browse' : ''}`} role={picker ? 'dialog' : undefined} aria-label={picker ? 'Attach context' : undefined}>
      <div className="context-picker-heading"><span>Attach context</span><span>Files · conversations · canvas</span><button type="button" className="icon-button" aria-label="Close context picker" onClick={() => { close(); inputRef.current?.focus(); }}><Icon name="close" size={13} /></button></div>
      {picker && <div className="context-search"><Icon name="search" size={14} /><input ref={queryInput} aria-label="Search context" role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={items[selected] ? `${listId}-${selected}` : undefined} value={query} placeholder="Search files, conversations, and canvas…" onChange={event => setQuery(event.target.value)} onKeyDown={keys} /></div>}
      <div className="context-suggestions" id={listId} role="listbox" aria-label="Context suggestions">
        {items.map((item, index) => <button type="button" role="option" aria-selected={selected === index} id={`${listId}-${index}`} key={`${item.reference.kind}:${item.label}:${index}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(index)} onClick={() => choose(item)}><Icon name={contextIcon(item.reference.kind)} size={15} /><span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span><span className="context-suggestion-kind">{item.reference.kind}</span></button>)}
        {loading && <div className="context-empty" role="status">Searching context…</div>}
        {!loading && !items.length && !error && <div className="context-empty">No matching context. Try a file name or conversation title.</div>}
        {error && <div className="context-empty context-error" role="alert">{error}</div>}
      </div><div className="context-picker-footer"><span>↑ ↓ to navigate · Enter to attach</span><span>Esc to close</span></div>
    </div>}
    {children({ onKeyDown: keys, onChange: updateMention, onSelect: updateMention, 'aria-controls': mention ? listId : undefined, 'aria-expanded': !!mention, 'aria-activedescendant': mention && items[selected] ? `${listId}-${selected}` : undefined })}
    {dragging && <div className="context-drop-overlay"><Icon name="image" size={22} /><span>{imageSupported ? 'Drop images to attach' : 'This agent does not accept images'}</span></div>}
  </div>;
}
