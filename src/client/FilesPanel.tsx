import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, ApiError, apiPath, errorMessage } from "./api";
import { Icon } from "./icons";
import type { CodeEditorHandle } from "./CodeEditor";

const CodeEditor = lazy(() => import("./CodeEditor").then(module => ({ default: module.CodeEditor })));

type Entry = { name: string; path: string; kind: "directory" | "file"; size?: number };
type Directory = { path: string; entries: Entry[]; truncated?: boolean };
type TextFile = { path: string; content: string; revision: string; size: number };
type IndexedFile = { path: string; name: string };
type SearchMatch = { path: string; line: number; column: number; text: string };
type OpenFile = { path: string; kind: "text" | "image" | "binary"; content: string; saved: string; revision: string; error?: string; saving?: boolean };
export type FilesPanelHandle = { prepareToLeave: () => Promise<boolean> };
const fileName = (path: string) => path.split("/").at(-1) || path;
const isDirty = (file: OpenFile) => file.kind === "text" && file.content !== file.saved;
const imageFile = (path: string) => /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i.test(path);

export const FilesPanel = forwardRef<FilesPanelHandle, { active: boolean; projectName: string; projectKey: string; command?: { id: number; kind: "open" | "find" | "search" | "palette" }; onError: (message: string) => void; onNeedsAttention: () => void }>(function FilesPanel({ active, projectName, projectKey, command, onError, onNeedsAttention }, ref) {
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState(new Set<string>([""]));
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [loading, setLoading] = useState("");
  const [treeError, setTreeError] = useState("");
  const [savingAll, setSavingAll] = useState(false);
  const [vimEnabled, setVimEnabled] = useState(true);
  const [vimSettingsBusy, setVimSettingsBusy] = useState(true);
  const [guardOpen, setGuardOpen] = useState(false);
  const [guardError, setGuardError] = useState("");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const filesRef = useRef(files);
  filesRef.current = files;
  const guardResult = useRef<(result: boolean) => void>();
  const guardDialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<CodeEditorHandle>(null);
  const openRequest = useRef(0);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickResults, setQuickResults] = useState<IndexedFile[]>([]);
  const [quickSelected, setQuickSelected] = useState(0);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState("");
  const [quickTruncated, setQuickTruncated] = useState(false);
  const quickDialog = useRef<HTMLDialogElement>(null);
  const quickInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [cursorTarget, setCursorTarget] = useState<{ path: string; line: number; column: number }>();
  const focusRequested = useRef(false);
  const pendingEditorCommand = useRef<"find" | "palette">();
  const current = files.find(file => file.path === activePath);
  const lastTextPath = useRef<string>();
  if (current?.kind === "text") lastTextPath.current = current.path;
  const editorFile = current?.kind === "text" ? current : files.find(file => file.path === lastTextPath.current) ?? files.find(file => file.kind === "text");
  const updateFiles = (update: (previous: OpenFile[]) => OpenFile[]) => {
    const next = update(filesRef.current);
    filesRef.current = next;
    setFiles(next);
  };

  useEffect(() => {
    let disposed = false;
    void api<{ vimEnabled: boolean }>("/api/editor/settings").then(settings => {
      if (!disposed) setVimEnabled(settings.vimEnabled);
    }).catch(error => { if (!disposed) onError(errorMessage(error)); }).finally(() => { if (!disposed) setVimSettingsBusy(false); });
    return () => { disposed = true; };
  }, []);
  const toggleVim = async () => {
    const next = !vimEnabled;
    setVimEnabled(next); setVimSettingsBusy(true);
    try { await api("/api/editor/settings", { vimEnabled: next }); }
    catch (error) { setVimEnabled(!next); onError(errorMessage(error)); }
    finally { setVimSettingsBusy(false); }
  };

  const loadDirectory = useCallback(async (path: string) => {
    const directory = await api<Directory>(`/api/files?path=${encodeURIComponent(path)}`);
    setDirectories(previous => ({ ...previous, [path]: directory }));
  }, []);
  useEffect(() => {
    if (active && !directories[""]) void loadDirectory("").catch(error => setTreeError(errorMessage(error)));
  }, [active, directories, loadDirectory]);

  const toggleDirectory = async (path: string) => {
    if (expanded.has(path)) { setExpanded(previous => { const next = new Set(previous); next.delete(path); return next; }); return; }
    setTreeError("");
    try {
      if (!directories[path]) await loadDirectory(path);
      setExpanded(previous => new Set([...previous, path]));
    } catch (error) { setTreeError(errorMessage(error)); }
  };
  const openFile = async (path: string, line?: number, column = 1) => {
    await editor.current?.settleEdits();
    focusRequested.current = true;
    setCursorTarget(line ? { path, line, column } : undefined);
    const request = ++openRequest.current;
    if (filesRef.current.some(file => file.path === path)) { setLoading(""); setActivePath(path); requestAnimationFrame(() => editorReady()); return; }
    setLoading(path);
    try {
      let file: OpenFile;
      if (imageFile(path)) file = { path, kind: "image", content: "", saved: "", revision: "" };
      else {
        try {
          const incoming = await api<TextFile>(`/api/files/content?path=${encodeURIComponent(path)}`);
          file = { path, kind: "text", content: incoming.content, saved: incoming.content, revision: incoming.revision };
        } catch (error) {
          if (!(error instanceof ApiError) || ![413, 415].includes(error.status)) throw error;
          file = { path, kind: "binary", content: "", saved: "", revision: "", error: error.message };
        }
      }
      updateFiles(previous => previous.some(item => item.path === path) ? previous : [...previous, file]);
      if (openRequest.current === request) { setActivePath(path); setCursor({ line: 1, column: 1 }); }
    } catch (error) { onError(errorMessage(error)); }
    finally { if (openRequest.current === request) setLoading(""); }
  };

  const beginQuickOpen = () => { setQuickQuery(""); setQuickError(""); setQuickOpen(true); };
  const runEditorCommand = (kind: "find" | "palette") => {
    if (!editor.current || current?.kind !== "text") {
      pendingEditorCommand.current = kind;
      if (current?.kind !== "text") beginQuickOpen();
      return;
    }
    if (kind === "find") editor.current.find(); else editor.current.commandPalette();
  };
  useEffect(() => {
    if (!command) return;
    if (command.kind === "open") beginQuickOpen();
    else if (command.kind === "search") { setSearchMode(true); requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); }); }
    else requestAnimationFrame(() => runEditorCommand(command.kind as "find" | "palette"));
  }, [command?.id]);
  useEffect(() => {
    if (quickOpen) { quickDialog.current?.showModal(); quickInput.current?.focus(); }
    else quickDialog.current?.close();
  }, [quickOpen]);
  useEffect(() => {
    if (!quickOpen) return;
    let disposed = false;
    const controller = new AbortController();
    setQuickBusy(true); setQuickSelected(0);
    const timer = setTimeout(() => {
      void api<{ files: IndexedFile[]; truncated: boolean }>(`/api/files/index?query=${encodeURIComponent(quickQuery)}`, undefined, { signal: controller.signal }).then(result => {
        if (!disposed) { setQuickResults(result.files); setQuickTruncated(result.truncated); setQuickError(""); }
      }).catch(error => { if (!disposed) { setQuickResults([]); setQuickTruncated(false); setQuickError(errorMessage(error)); } }).finally(() => { if (!disposed) setQuickBusy(false); });
    }, 120);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [quickOpen, quickQuery]);
  useEffect(() => { quickDialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [quickSelected, quickResults]);
  useEffect(() => {
    if (!searchMode || !searchQuery.trim()) { setSearchMatches([]); setSearchBusy(false); setSearchError(""); return; }
    let disposed = false;
    const controller = new AbortController();
    setSearchBusy(true);
    const timer = setTimeout(() => {
      void api<{ matches: SearchMatch[]; truncated: boolean }>(`/api/files/search?query=${encodeURIComponent(searchQuery)}&caseSensitive=${searchCase}&regex=${searchRegex}&wholeWord=${searchWholeWord}`, undefined, { signal: controller.signal }).then(result => {
        if (!disposed) { setSearchMatches(result.matches); setSearchTruncated(result.truncated); setSearchError(""); }
      }).catch(error => { if (!disposed) { setSearchMatches([]); setSearchError(errorMessage(error)); } }).finally(() => { if (!disposed) setSearchBusy(false); });
    }, 240);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [searchMode, searchQuery, searchCase, searchRegex, searchWholeWord]);
  const revealTarget = () => {
    if (cursorTarget && cursorTarget.path === activePath && editor.current) {
      editor.current.goToLine(cursorTarget.line, cursorTarget.column); setCursorTarget(undefined);
    }
  };
  const editorReady = () => {
    if (current?.kind !== "text" || !editor.current) return;
    revealTarget();
    const pending = pendingEditorCommand.current;
    if (pending) { pendingEditorCommand.current = undefined; runEditorCommand(pending); }
    else if (focusRequested.current) editor.current.focus();
    focusRequested.current = false;
  };
  useEffect(editorReady, [activePath, cursorTarget]);
  const chooseQuickFile = (file?: IndexedFile) => {
    if (!file) return;
    setQuickOpen(false);
    void openFile(file.path);
  };
  const saveFile = async (path: string): Promise<boolean> => {
    await editor.current?.settleEdits();
    const file = filesRef.current.find(item => item.path === path);
    if (!file || !isDirty(file)) return true;
    if (file.saving) return false;
    updateFiles(previous => previous.map(item => item.path === path ? { ...item, saving: true, error: undefined } : item));
    try {
      const saved = await api<TextFile>("/api/files/content", { path, content: file.content, revision: file.revision });
      updateFiles(previous => previous.map(item => item.path === path ? { ...item, revision: saved.revision, saved: saved.content, saving: false } : item));
      return true;
    } catch (error) {
      updateFiles(previous => previous.map(item => item.path === path ? { ...item, saving: false, error: errorMessage(error) } : item));
      return false;
    }
  };
  const reloadFile = async (path: string) => {
    await editor.current?.settleEdits();
    const file = filesRef.current.find(item => item.path === path);
    if (!file || file.saving) return;
    if (file.kind === "image") { updateFiles(previous => previous.map(item => item.path === path ? { ...item, revision: String(Date.now()) } : item)); return; }
    if (file.kind !== "text") return;
    if (file && isDirty(file) && !window.confirm(`Discard your unsaved edits and reload ${path} from disk?`)) return;
    setLoading(path);
    try {
      const incoming = await api<TextFile>(`/api/files/content?path=${encodeURIComponent(path)}`);
      const latest = filesRef.current.find(item => item.path === path);
      if (!latest) return;
      if (latest.content !== file.content || latest.revision !== file.revision || latest.saving) { onError("The file changed in the editor while reloading. Your edits were kept."); return; }
      updateFiles(previous => previous.map(item => item.path === path ? { ...item, content: incoming.content, saved: incoming.content, revision: incoming.revision, error: undefined } : item));
    } catch (error) { onError(errorMessage(error)); }
    finally { setLoading(""); }
  };
  const closeFile = async (path: string) => {
    await editor.current?.settleEdits();
    const file = filesRef.current.find(item => item.path === path);
    if (file?.saving) return;
    if (file && isDirty(file) && !window.confirm(`Discard unsaved edits to ${path}?`)) return;
    const remaining = filesRef.current.filter(item => item.path !== path);
    updateFiles(() => remaining);
    setActivePath(previous => previous === path ? remaining.at(-1)?.path : previous);
  };

  useImperativeHandle(ref, () => ({ prepareToLeave: async () => {
    await editor.current?.settleEdits();
    if (!filesRef.current.some(isDirty)) return true;
    if (guardResult.current) return false;
    onNeedsAttention();
    setGuardError("");
    setGuardOpen(true);
    return new Promise<boolean>(resolve => { guardResult.current = resolve; });
  } }));
  const finishGuard = (result: boolean) => {
    setGuardOpen(false);
    guardResult.current?.(result);
    guardResult.current = undefined;
  };
  const saveAndLeave = async () => {
    setSavingAll(true);
    try {
      for (const file of filesRef.current.filter(isDirty)) {
        if (!await saveFile(file.path)) {
          setActivePath(file.path);
          setGuardError(`Could not save ${file.path}. Cancel to review the file and keep your edits.`);
          return;
        }
      }
      finishGuard(true);
    } finally { setSavingAll(false); }
  };
  useEffect(() => {
    if (guardOpen) guardDialog.current?.showModal();
    else guardDialog.current?.close();
  }, [guardOpen]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (filesRef.current.some(isDirty)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => () => { guardResult.current?.(false); }, []);

  const tree = (path: string, depth = 0): React.ReactNode => directories[path]?.entries.map(entry => <div key={entry.path}>
    <button className={`file-tree-entry ${entry.path === activePath ? "active" : ""}`} style={{ paddingLeft: 12 + depth * 14 }} aria-label={`${entry.kind === "directory" ? `${expanded.has(entry.path) ? "Collapse" : "Expand"} folder` : "Open file"}: ${entry.path}`} aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined} title={entry.path} onClick={() => void (entry.kind === "directory" ? toggleDirectory(entry.path) : openFile(entry.path))}>
      {entry.kind === "directory" ? <><Icon name="chevron" size={12} className={expanded.has(entry.path) ? "" : "project-collapsed"} /><Icon name="folder" size={14} /></> : <><span className="file-tree-indent" /><Icon name={imageFile(entry.path) ? "image" : "file"} size={14} /></>}
      <span>{entry.name}</span>{loading === entry.path && <span className="working-spinner" />}
    </button>
    {entry.kind === "directory" && expanded.has(entry.path) && tree(entry.path, depth + 1)}
  </div>);

  return <div className="files-panel">
    <aside className={`file-explorer ${searchMode ? "search-mode" : ""}`} aria-label="Project files"><div className="file-explorer-heading"><strong title={projectName}>{projectName}</strong><button className="icon-button" title="Quick Open (⌘P / Ctrl+P)" aria-label="Quick Open" onClick={beginQuickOpen}><Icon name="file" size={14} /></button><button className="icon-button" title="Search in files (⌘⇧F / Ctrl+Shift+F)" aria-label={searchMode ? "Show file explorer" : "Search in files"} onClick={() => { setSearchMode(!searchMode); requestAnimationFrame(() => searchInput.current?.focus()); }}><Icon name={searchMode ? "folder" : "search"} size={14} /></button><button className="icon-button" title="Refresh files" aria-label="Refresh files" onClick={() => { setTreeError(""); void Promise.all([...expanded].map(loadDirectory)).catch(error => setTreeError(errorMessage(error))); }}><Icon name="reconnect" size={14} /></button></div>
      {searchMode ? <div className="workspace-search"><div className="workspace-search-input"><Icon name="search" size={13} /><input ref={searchInput} aria-label="Search in files" placeholder="Search project contents" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} /></div><div className="workspace-search-options"><button aria-label="Match case" aria-pressed={searchCase} title="Match case" onClick={() => setSearchCase(!searchCase)}>Aa</button><button aria-label="Match whole word" aria-pressed={searchWholeWord} title="Match whole word" onClick={() => setSearchWholeWord(!searchWholeWord)}>Ab</button><button aria-label="Use regular expression" aria-pressed={searchRegex} title="Use regular expression" onClick={() => setSearchRegex(!searchRegex)}>.*</button>{searchBusy && <span className="working-spinner" />}</div>{searchError && <p className="file-tree-note file-error" role="alert">{searchError}</p>}{searchQuery.trim() && !searchBusy && !searchError && <p className="workspace-search-count">{searchMatches.length} {searchMatches.length === 1 ? "match" : "matches"}{searchTruncated ? " · narrow your search for more" : ""}</p>}<div className="workspace-search-results">{searchMatches.map((match, index) => <button key={`${match.path}:${match.line}:${match.column}:${index}`} aria-label={`Open search result: ${match.path}:${match.line}:${match.column}`} title={`${match.path}:${match.line}`} onClick={() => void openFile(match.path, match.line, match.column)}><span>{match.path}</span><small><i>{match.line}</i>{match.text}</small></button>)}</div>{!searchQuery.trim() && <p className="file-tree-note">Search text across this project.<br />⌘⇧F / Ctrl+Shift+F</p>}</div> : <div className="file-tree">{tree("")}{directories[""]?.entries.length === 0 && <p className="file-tree-note">This folder is empty.</p>}{directories[""]?.truncated && <p className="file-tree-note">Showing the first 1,000 entries.</p>}{treeError && <p className="file-tree-note file-error" role="alert">{treeError}</p>}</div>}
    </aside>
    <div className="file-workspace">
      {files.length > 0 && <div className="file-tabs" role="tablist" aria-label="Open files">{files.map(file => <div className={`file-tab ${activePath === file.path ? "active" : ""}`} key={file.path}><button role="tab" aria-selected={activePath === file.path} title={file.path} onClick={() => void openFile(file.path)}>{isDirty(file) && <span className="file-dirty-dot" />}<span>{fileName(file.path)}</span></button><button aria-label={`Close file: ${file.path}`} onClick={() => closeFile(file.path)}><Icon name="close" size={12} /></button></div>)}</div>}
      {current ? <>
        <div className="file-editor-toolbar"><span title={current.path}>{current.path}</span><div>{current.kind === "text" && <><button className="toolbar-button" aria-label="Vim key bindings" aria-pressed={vimEnabled} title={vimEnabled ? "Disable Vim key bindings" : "Enable Vim key bindings"} disabled={vimSettingsBusy} onClick={() => void toggleVim()}>Vim {vimEnabled ? "on" : "off"}</button><button className="toolbar-button" aria-label="Find in file" title="Find in file (⌘F / Ctrl+F)" onClick={() => editor.current?.find()}><Icon name="search" size={14} /></button><button className="toolbar-button" aria-label="Editor commands" title="Editor commands (⌘⇧P / Ctrl+Shift+P)" onClick={() => editor.current?.commandPalette()}><Icon name="settings" size={14} /></button></>}<button className="toolbar-button" aria-label="Reload file" title="Reload file from disk" disabled={current.kind === "binary" || current.saving || !!loading} onClick={() => void reloadFile(current.path)}><Icon name="reconnect" size={14} /></button>{current.kind === "text" && <button className="file-save" disabled={!isDirty(current) || current.saving} onClick={() => void saveFile(current.path)}><Icon name="save" size={14} />{current.saving ? "Saving…" : "Save file"}</button>}</div></div>
        {current.error && current.kind === "text" && <div className="file-conflict" role="alert"><Icon name="warning" size={15} /><span>{current.error} Your edits are still here.</span></div>}
        <div className="file-code-surface" hidden={current.kind !== "text"}>{editorFile && <Suspense fallback={<div className="panel-empty"><span className="working-spinner" /><p>Opening editor…</p></div>}><CodeEditor ref={editor} onError={onError} path={editorFile.path} projectKey={projectKey} content={editorFile.content} vimEnabled={vimEnabled} readOnly={current.kind !== "text" || !!editorFile.saving || savingAll || loading === editorFile.path} openPaths={files.filter(file => file.kind === "text").map(file => file.path)} onChange={content => updateFiles(previous => previous.map(file => file.path === editorFile.path ? { ...file, content } : file))} onSave={() => void saveFile(editorFile.path)} onCursorChange={setCursor} onReady={editorReady} /></Suspense>}</div>
        {current.kind === "text" ? <footer className="file-editor-footer"><span>{isDirty(current) ? "Unsaved changes" : "Saved"}</span><span>Ln {cursor.line}, Col {cursor.column}<span className="file-footer-separator">·</span>UTF-8</span></footer> : current.kind === "image" ? <div className="file-image-preview"><img src={apiPath(`/api/files/raw?path=${encodeURIComponent(current.path)}&v=${current.revision}`)} alt={current.path} /></div> : <div className="panel-empty"><Icon name="file" size={28} /><h2>{fileName(current.path)}</h2><p>{current.error || "Download this file to open it in another app."}</p><a className="panel-primary" href={apiPath(`/api/files/raw?path=${encodeURIComponent(current.path)}`)} download={fileName(current.path)}><Icon name="download" size={15} />Download file</a></div>}
      </> : <div className="panel-empty"><Icon name="folder" size={30} /><h2>Your project files</h2><p>Open a file with ⌘P or Ctrl+P.<br />Search this project with ⌘⇧F or Ctrl+Shift+F.</p><button className="panel-primary" onClick={beginQuickOpen}><Icon name="search" size={14} />Quick Open</button></div>}
    </div>
    <dialog ref={quickDialog} className="quick-open-dialog" aria-label="Quick Open" onCancel={() => setQuickOpen(false)} onClose={() => setQuickOpen(false)}><div className="quick-open-input"><Icon name="search" size={16} /><input ref={quickInput} aria-label="Search files by name" placeholder="Search files by name…" value={quickQuery} onChange={event => setQuickQuery(event.target.value)} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setQuickSelected(previous => Math.min(Math.max(0, previous + (event.key === "ArrowDown" ? 1 : -1)), Math.max(0, quickResults.length - 1))); }
      else if (event.key === "Enter" && !quickBusy) { event.preventDefault(); chooseQuickFile(quickResults[quickSelected]); }
    }} />{quickBusy && <span className="working-spinner" />}</div><div className="quick-open-results" role="listbox" aria-label="Matching files">{quickResults.map((file, index) => <button key={file.path} role="option" aria-selected={index === quickSelected} disabled={quickBusy} onClick={() => chooseQuickFile(file)}><Icon name="file" size={15} /><strong>{file.name}</strong><span>{file.path}</span></button>)}{!quickBusy && !quickResults.length && !quickError && <p>No matching files.</p>}{quickError && <p className="file-error" role="alert">{quickError}</p>}</div><footer>↑↓ to select · Enter to open · Esc to close{quickTruncated ? " · Type to narrow results" : ""}</footer></dialog>
    <dialog ref={guardDialog} className="project-dialog" aria-label="Unsaved file changes" onCancel={event => { if (savingAll) event.preventDefault(); else finishGuard(false); }}>
      <h2>Unsaved file changes</h2><p>{files.filter(isDirty).length} {files.filter(isDirty).length === 1 ? "file has" : "files have"} unsaved edits. Save them before leaving this project?</p>
      {guardError && <p className="project-dialog-error" role="alert">{guardError}</p>}
      <div className="project-dialog-actions"><button disabled={savingAll} onClick={() => finishGuard(false)}>Cancel</button><button disabled={savingAll} onClick={() => { updateFiles(previous => previous.map(file => ({ ...file, content: file.saved }))); finishGuard(true); }}>Discard changes</button><button className="button-dark" disabled={savingAll} onClick={() => void saveAndLeave()}>{savingAll ? "Saving…" : "Save and switch"}</button></div>
    </dialog>
  </div>;
});
