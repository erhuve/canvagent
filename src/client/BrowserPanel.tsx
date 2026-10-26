import { useCallback, useEffect, useRef, useState } from "react";
import { desktopInvoke, hasDesktopBridge } from "./desktop";
import { errorMessage } from "./api";
import { Icon } from "./icons";
import '../shared/browser-annotations.js';
import type { AnnotationCommand, AnnotationState, AnnotationTool, BrowserAnnotator } from '../shared/browser-annotations';
import './BrowserAnnotations.css';

type BrowserState = { url: string; title?: string; loading?: boolean; canGoBack?: boolean; canGoForward?: boolean; error?: string | null };
const emptyAnnotations: AnnotationState = { active: false, tool: 'pen', color: '#e5484d', count: 0, canUndo: false, documentId: '' };
const annotationColors = [['Red', '#e5484d'], ['Yellow', '#e9ad28'], ['Blue', '#3f7fe0'], ['Green', '#38a16c'], ['Purple', '#8b5cf6']] as const;
function browserUrl(input: string) {
  const value = input.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(value) ? "http" : "https"}://${value}`);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Enter an http or https address.");
  return url.href;
}

export function BrowserPanel({ active, projectKey }: { active: boolean; projectKey: string }) {
  const [address, setAddress] = useState("");
  const [state, setState] = useState<BrowserState>({ url: "" });
  const [error, setError] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);
  const native = hasDesktopBridge();
  const frame = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const stateRef = useRef(state);
  const nativeTail = useRef<Promise<unknown>>(Promise.resolve());
  const desiredVisibility = useRef("");
  const pollBusy = useRef(false);
  const loadingSince = useRef(0);
  const navigationGeneration = useRef(0);
  const editingAddress = useRef(false);
  const layoutResizing = useRef(false);
  const [annotations, setAnnotations] = useState<AnnotationState>(emptyAnnotations);
  const annotationRef = useRef(annotations);
  const webAnnotator = useRef<BrowserAnnotator>();
  const annotationGeneration = useRef(0);
  const annotationPollBusy = useRef(false);
  const [annotationError, setAnnotationError] = useState('');
  // Native visibility and navigation are ordered operations. In particular an
  // older hide must finish before showing the view for the active Browser tab.
  const nativeCommand = useCallback(<T,>(command: Parameters<typeof desktopInvoke>[0], args?: Record<string, unknown>): Promise<T> => {
    const task = nativeTail.current.catch(() => undefined).then(() => desktopInvoke<T>(command, args));
    nativeTail.current = task;
    return task;
  }, []);
  const syncState = useCallback((incoming: BrowserState) => {
    const previous = stateRef.current;
    const next = { ...previous, ...incoming, url: incoming.url || previous.url };
    // WKWebView can return an empty snapshot before its first load starts.
    if (!incoming.url && !incoming.error && previous.loading) next.loading = true;
    if (next.loading && !previous.loading) loadingSince.current = Date.now();
    if (next.error) { next.loading = false; setError(next.error); }
    else if (incoming.url && incoming.title && !next.loading) setError("");
    stateRef.current = next;
    setState(next);
    if (!editingAddress.current && next.url) setAddress(next.url);
  }, []);
  const syncAnnotations = useCallback((incoming: AnnotationState) => {
    if (JSON.stringify(annotationRef.current) === JSON.stringify(incoming)) return;
    annotationRef.current = incoming;
    setAnnotations(incoming);
  }, []);
  const resetWebAnnotations = useCallback(() => {
    annotationGeneration.current += 1;
    webAnnotator.current?.dispose(); webAnnotator.current = undefined;
    syncAnnotations({ ...emptyAnnotations, tool: annotationRef.current.tool, color: annotationRef.current.color });
    setAnnotationError('');
  }, [syncAnnotations]);
  const annotate = useCallback(async (input: AnnotationCommand) => {
    const generation = input.command === 'state' ? annotationGeneration.current : ++annotationGeneration.current;
    try {
      const command = input.command === 'state' ? input : { tool: annotationRef.current.tool, color: annotationRef.current.color, ...input };
      let incoming: AnnotationState;
      if (native) incoming = await nativeCommand<AnnotationState>('browser_annotate', command);
      else {
        if (!frame.current || !window.__CANVAGENT_CREATE_BROWSER_ANNOTATIONS__) throw new Error('The annotation surface is not ready.');
        webAnnotator.current ??= window.__CANVAGENT_CREATE_BROWSER_ANNOTATIONS__(frame.current);
        incoming = webAnnotator.current.command(command);
      }
      if (generation === annotationGeneration.current) {
        if (input.command === 'state' && incoming.documentId !== annotationRef.current.documentId) incoming = { ...incoming, tool: annotationRef.current.tool, color: annotationRef.current.color };
        syncAnnotations(incoming); setAnnotationError('');
      }
    } catch (problem) { if (generation === annotationGeneration.current) setAnnotationError(errorMessage(problem)); }
  }, [native, nativeCommand, syncAnnotations]);
  useEffect(() => { resetWebAnnotations(); }, [state.url, reloadKey, resetWebAnnotations]);
  useEffect(() => () => { webAnnotator.current?.dispose(); }, []);
  useEffect(() => { if (!active && annotationRef.current.active) void annotate({ command: 'stop' }); }, [active, annotate]);
  useEffect(() => {
    if (!native || !active || !annotations.active) return;
    const stop = (event: KeyboardEvent) => {
      // The toolbar keeps focus in the app; the embedded page handles Escape
      // itself once drawing moves focus into its separate native webview.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open], .sidebar-open')) return;
      event.preventDefault(); event.stopPropagation();
      void annotate({ command: 'stop' });
    };
    window.addEventListener('keydown', stop);
    return () => window.removeEventListener('keydown', stop);
  }, [native, active, annotations.active, annotate]);
  useEffect(() => {
    if (!active || !state.url || (!annotations.active && !annotations.count)) return;
    let disposed = false;
    const poll = async () => {
      if (annotationPollBusy.current || (!annotationRef.current.active && !annotationRef.current.count)) return;
      annotationPollBusy.current = true;
      try { if (!disposed) await annotate({ command: 'state' }); }
      finally { annotationPollBusy.current = false; }
    };
    const timer = setInterval(() => void poll(), 250);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, state.url, annotations.active, annotations.count, annotate]);
  const bounds = () => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1 || !activeRef.current || layoutResizing.current || document.querySelector("dialog[open], .sidebar-open, .layout-resizing")) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const navigate = async (value: string) => {
    let generation: number | undefined;
    try {
      const url = browserUrl(value);
      setError("");
      setAddress(url);
      editingAddress.current = false;
      try { sessionStorage.setItem(`canvagent:browser:${projectKey}`, url); } catch { /* Optional convenience. */ }
      if (native) {
        const rectangle = bounds();
        if (!rectangle) return;
        generation = ++navigationGeneration.current;
        loadingSince.current = Date.now();
        stateRef.current = { url, loading: true, error: null };
        setState(stateRef.current);
        const incoming = await nativeCommand<BrowserState>("browser_open", { url, bounds: rectangle });
        if (navigationGeneration.current === generation) syncState(incoming);
        desiredVisibility.current = "";
        if (!activeRef.current) await nativeCommand("browser_hide");
      } else {
        const next = [...history.slice(0, historyIndex + 1), url];
        setHistory(next);
        setHistoryIndex(next.length - 1);
        stateRef.current = { url, loading: true }; setState(stateRef.current);
      }
    } catch (problem) {
      if (generation !== undefined && navigationGeneration.current !== generation) return;
      setError(errorMessage(problem)); stateRef.current = { ...stateRef.current, loading: false }; setState(stateRef.current);
    }
  };
  // Leave a useful address ready on returning to a project, without reopening
  // a network page until its Browser tab is selected.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(`canvagent:browser:${projectKey}`);
      if (saved) setAddress(saved);
    } catch { /* Storage can be unavailable in a browser. */ }
  }, [projectKey]);

  useEffect(() => {
    if (!native) return;
    if (!active) { desiredVisibility.current = "hidden"; void nativeCommand("browser_hide").catch(() => undefined); return; }
    let disposed = false;
    let scheduled = 0;
    const resize = () => {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        const rectangle = bounds();
        const visible = rectangle && stateRef.current.url && !stateRef.current.error;
        const desired = visible ? JSON.stringify(rectangle) : "hidden";
        if (desiredVisibility.current === desired) return;
        desiredVisibility.current = desired;
        const task = visible ? nativeCommand("browser_bounds", { bounds: rectangle }) : nativeCommand("browser_hide");
        void task.catch(problem => { desiredVisibility.current = ""; if (!disposed) setError(errorMessage(problem)); });
      });
    };
    const observer = new ResizeObserver(resize);
    if (frame.current) observer.observe(frame.current);
    const overlays = new MutationObserver(resize);
    overlays.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open", "class", "hidden"] });
    window.addEventListener("resize", resize);
    const layout = (event: Event) => {
      layoutResizing.current = !!(event as CustomEvent<{ active: boolean }>).detail?.active;
      desiredVisibility.current = '';
      if (layoutResizing.current) { desiredVisibility.current = 'hidden'; void nativeCommand('browser_hide').catch(() => undefined); }
      else resize();
    };
    window.addEventListener('canvagent:layout-resize', layout);
    resize();
    const poll = async () => {
      if (pollBusy.current || !stateRef.current.url) return;
      pollBusy.current = true;
      const generation = navigationGeneration.current;
      try {
        const incoming = await desktopInvoke<BrowserState>("browser_state");
        if (!disposed && navigationGeneration.current === generation) {
          syncState(incoming);
          if (stateRef.current.loading && Date.now() - loadingSince.current > 15000) {
            setError("This page is taking too long to load. Check its address or try reloading.");
          }
          resize();
        }
      } catch (problem) { if (!disposed) setError(errorMessage(problem)); }
      finally { pollBusy.current = false; }
    };
    const timer = setInterval(() => void poll(), 700);
    return () => { disposed = true; clearInterval(timer); cancelAnimationFrame(scheduled); observer.disconnect(); overlays.disconnect(); window.removeEventListener("resize", resize); window.removeEventListener('canvagent:layout-resize', layout); layoutResizing.current = false; desiredVisibility.current = "hidden"; void nativeCommand("browser_hide").catch(() => undefined); };
  }, [active, native, nativeCommand, syncState]);

  const action = async (action: "back" | "forward" | "reload") => {
    if (native) {
      if (action === "reload" && error && stateRef.current.url) { await navigate(stateRef.current.url); return; }
      let generation: number | undefined;
      try {
        generation = ++navigationGeneration.current;
        setError(""); loadingSince.current = Date.now();
        const incoming = await nativeCommand<BrowserState>("browser_action", { action });
        if (navigationGeneration.current === generation) syncState(incoming);
      }
      catch (problem) { if (generation === navigationGeneration.current) setError(errorMessage(problem)); }
    } else if (action === "reload") setReloadKey(previous => previous + 1);
    else {
      const nextIndex = historyIndex + (action === "back" ? -1 : 1);
      if (history[nextIndex]) { setHistoryIndex(nextIndex); stateRef.current = { url: history[nextIndex], loading: true }; setState(stateRef.current); setAddress(history[nextIndex]); }
    }
  };
  const canBack = native ? state.canGoBack : historyIndex > 0;
  const canForward = native ? state.canGoForward : historyIndex >= 0 && historyIndex < history.length - 1;
  return <div className="browser-panel">
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); void navigate(address); }}>
      <button type="button" className="icon-button" aria-label="Browser back" disabled={!canBack} onClick={() => void action("back")}><Icon name="left" size={16} /></button>
      <button type="button" className="icon-button" aria-label="Browser forward" disabled={!canForward} onClick={() => void action("forward")}><Icon name="arrow-right" size={16} /></button>
      <button type="button" className="icon-button" aria-label="Reload browser" disabled={!state.url} onClick={() => void action("reload")}><Icon name="reconnect" size={15} /></button>
      <div className="browser-address"><Icon name="globe" size={14} /><input aria-label="Browser address" placeholder="Enter a URL or localhost:3000" value={address} onChange={event => setAddress(event.target.value)} onFocus={event => { editingAddress.current = true; event.currentTarget.select(); }} onBlur={() => { editingAddress.current = false; }} autoComplete="off" spellCheck={false} /><button aria-label="Go to address" disabled={!address.trim()}><Icon name="arrow-right" size={14} /></button></div>
      <button type="button" className="browser-annotate-toggle" aria-label="Annotate browser" aria-pressed={annotations.active} disabled={!state.url || state.loading || !!error} title={annotations.active ? 'Finish annotating (Esc)' : 'Draw on this page'} onClick={() => void annotate({ command: annotations.active ? 'stop' : 'start', tool: annotations.tool, color: annotations.color })}><Icon name="compose" size={14} /><span>{annotations.active ? 'Done' : 'Annotate'}</span></button>
      {state.url && <a className="icon-button" aria-label="Open browser page externally" title="Open in your default browser" href={state.url} target="_blank" rel="noreferrer"><Icon name="external" size={15} /></a>}
    </form>
    {(annotations.active || annotations.count > 0) && <div className="browser-annotation-toolbar" aria-label="Browser annotation tools">
      {([['pen', 'Pen'], ['highlight', 'Highlighter'], ['rectangle', 'Rectangle']] as const).map(([tool, title]) => <button key={tool} type="button" aria-label={`Annotation ${title.toLowerCase()}`} aria-pressed={annotations.tool === tool} title={title} onClick={() => void annotate({ command: 'start', tool: tool as AnnotationTool, color: annotations.color })}>{tool === 'rectangle' ? '▢' : tool === 'highlight' ? '▰' : <Icon name="compose" size={14} />}</button>)}
      <span className="annotation-tool-separator" />
      {annotationColors.map(([name, color]) => <button key={color} className="annotation-color" type="button" aria-label={`Annotation color: ${name}`} aria-pressed={annotations.color === color} title={name} onClick={() => void annotate({ command: 'settings', color })}><i style={{ background: color }} /></button>)}
      <span className="annotation-tool-separator" />
      <button type="button" aria-label="Undo browser annotation" title="Undo annotation" disabled={!annotations.canUndo} onClick={() => void annotate({ command: 'undo' })}><Icon name="undo" size={14} /></button>
      <button type="button" aria-label="Clear browser annotations" title="Clear annotations" disabled={!annotations.count && !annotations.canUndo} onClick={() => void annotate({ command: 'clear' })}><Icon name="close" size={14} /></button>
      <span className="annotation-count" role="status">{annotations.count} {annotations.count === 1 ? 'annotation' : 'annotations'}</span>
    </div>}
    {annotationError && <div className="file-conflict" role="alert"><Icon name="warning" size={15} /><span>{annotationError}</span></div>}
    {error && <div className="file-conflict" role="alert"><Icon name="warning" size={15} /><span>{error}</span></div>}
    {state.loading && !error && <div className="browser-loading" role="status" aria-label="Loading browser page"><span className="working-spinner" />Loading page…</div>}
    <div ref={frame} className="browser-viewport">
      {!state.url ? <div className="panel-empty"><Icon name="globe" size={32} /><h2>A browser beside your work</h2><p>Open your app preview, documentation, or a website.<br />Keep chat and your project in view.</p><button className="panel-primary" onClick={() => void navigate(address || "http://localhost:3000")}><Icon name="external" size={14} />{address ? "Open saved page" : "Open localhost:3000"}</button></div> : !native ? <iframe key={reloadKey} title="Project browser" src={state.url} onLoad={() => { resetWebAnnotations(); stateRef.current = { ...stateRef.current, loading: false }; setState(previous => ({ ...previous, loading: false })); }} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerPolicy="no-referrer" /> : <div className="native-browser-placeholder" />}
    </div>
    <footer className="browser-footer"><span>{state.title || (state.url ? new URL(state.url).hostname : "Ready to browse")}</span><span>{native ? "Embedded browser" : "Desktop supports sites that block embedding"}</span></footer>
  </div>;
}
