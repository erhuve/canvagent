import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, ApiError, apiPath, errorMessage } from "./api";
import { Icon } from "./icons";
import type { CodeEditorHandle } from "./CodeEditor";
import { FileActionMenu, FileOperationDialog, type FileActionTarget, type FileInfo, type FileMenuState, type FileOperation } from "./FileActions";

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
const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const withinPath = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
const remapPath = (path: string, before: string, after: string) => withinPath(path, before) ? `${after}${path.slice(before.length)}` : path;
type FileNotice = { message: string; trashId?: string; path?: string; openPaths?: string[]; expandedPaths?: string[]; activePath?: string; error?: string };

export const FilesPanel = forwardRef<FilesPanelHandle, { active: boolean; projectName: string; projectKey: string; contextSessionId?: string; command?: { id: number; kind: "open" | "find" | "search" | "palette" }; onError: (message: string) => void; onNeedsAttention: () => void }>(function FilesPanel({ active, projectName, projectKey, contextSessionId, command, onError, onNeedsAttention }, ref) {
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
  const [selection, setSelection] = useState<{ startLine: number; endLine: number }>();
  const [attaching, setAttaching] = useState(false);
  const attachPending = useRef(false);
  const contextSession = useRef(contextSessionId);
  contextSession.current = contextSessionId;
  const filesRef = useRef(files);
  filesRef.current = files;
  const guardResult = useRef<(result: boolean) => void>();
  const guardDialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<CodeEditorHandle>(null);
  const openRequest = useRef(0);
  const fileReadVersion = useRef(0);
  const directoryVersion = useRef(0);
  const scope = useRef({ active: true, key: projectKey });
  const [selectedEntry, setSelectedEntry] = useState<FileActionTarget>();
  const [fileMenu, setFileMenu] = useState<FileMenuState>();
  const menuOrigin = useRef<HTMLElement>();
  const [operation, setOperation] = useState<FileOperation>();
  const operationRef = useRef<FileOperation>();
  const [operationName, setOperationName] = useState("");
  const [operationInfo, setOperationInfo] = useState<FileInfo>();
  const [operationLoading, setOperationLoading] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const mutationPending = useRef(false);
  const [operationError, setOperationError] = useState("");
  const [operationNotice, setOperationNotice] = useState("");
  const [fileNotice, setFileNotice] = useState<FileNotice>();
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
    const token = { active: true, key: projectKey };
    scope.current = token;
    return () => { token.active = false; openRequest.current++; };
  }, [projectKey]);
  useEffect(() => { if (!active) setFileMenu(undefined); }, [active]);

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
    const token = scope.current;
    const version = directoryVersion.current;
    const directory = await api<Directory>(`/api/files?path=${encodeURIComponent(path)}`);
    if (token.active && scope.current === token && directoryVersion.current === version) setDirectories(previous => ({ ...previous, [path]: directory }));
  }, []);
  useEffect(() => {
    if (active && !directories[""]) void loadDirectory("").catch(error => setTreeError(errorMessage(error)));
  }, [active, directories, loadDirectory]);

  const toggleDirectory = async (path: string) => {
    if (mutationPending.current) return;
    const token = scope.current;
    const version = directoryVersion.current;
    if (expanded.has(path)) { setExpanded(previous => { const next = new Set(previous); next.delete(path); return next; }); return; }
    setTreeError("");
    try {
      if (!directories[path]) await loadDirectory(path);
      if (token.active && scope.current === token && directoryVersion.current === version) setExpanded(previous => new Set([...previous, path]));
    } catch (error) { if (token.active && scope.current === token) setTreeError(errorMessage(error)); }
  };
  const openFile = async (path: string, line?: number, column = 1, duringMutation = false) => {
    if (mutationPending.current && !duringMutation) return;
    const token = scope.current;
    await editor.current?.settleEdits();
    if (!token.active || scope.current !== token || mutationPending.current && !duringMutation) return;
    focusRequested.current = true;
    setCursorTarget(line ? { path, line, column } : undefined);
    const request = ++openRequest.current;
    const readVersion = fileReadVersion.current;
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
      if (!token.active || scope.current !== token || fileReadVersion.current !== readVersion) return;
      updateFiles(previous => previous.some(item => item.path === path) ? previous : [...previous, file]);
      if (openRequest.current === request) { setActivePath(path); setCursor({ line: 1, column: 1 }); }
    } catch (error) { if (token.active && scope.current === token && fileReadVersion.current === readVersion) onError(errorMessage(error)); }
    finally { if (token.active && scope.current === token && openRequest.current === request) setLoading(""); }
  };

  const beginQuickOpen = () => { if (mutationPending.current) return; setQuickQuery(""); setQuickError(""); setQuickOpen(true); };
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
    const token = scope.current;
    await editor.current?.settleEdits();
    if (!token.active || scope.current !== token) return false;
    const file = filesRef.current.find(item => item.path === path);
    if (!file || !isDirty(file)) return true;
    if (file.saving) return false;
    updateFiles(previous => previous.map(item => item.path === path ? { ...item, saving: true, error: undefined } : item));
    try {
      const saved = await api<TextFile>("/api/files/content", { path, content: file.content, revision: file.revision });
      if (!token.active || scope.current !== token) return false;
      updateFiles(previous => previous.map(item => item.path === path ? { ...item, revision: saved.revision, saved: saved.content, saving: false } : item));
      return true;
    } catch (error) {
      if (token.active && scope.current === token) updateFiles(previous => previous.map(item => item.path === path ? { ...item, saving: false, error: errorMessage(error) } : item));
      return false;
    }
  };
  const attachFile = async (path: string, selectedLines?: { startLine: number; endLine: number }) => {
    if (attachPending.current) return;
    const file = filesRef.current.find(file => file.path === path);
    if (!file || file.kind !== "text" || file.saving || loading === path || savingAll) return;
    // Preserve the selected lines before saving causes cursor or model updates.
    const range = selectedLines ? { ...selectedLines } : undefined;
    const targetSession = contextSession.current;
    attachPending.current = true; setAttaching(true);
    try {
      if (!await saveFile(path)) return;
      if (contextSession.current !== targetSession) { onError("The file was saved. Return to the original conversation to attach this selection."); return; }
      const latest = filesRef.current.find(file => file.path === path);
      if (latest && isDirty(latest)) { onError("The file changed while attaching it. Save your latest edits and attach it again."); return; }
      window.dispatchEvent(new CustomEvent("canvagent:attach-context", { detail: { reference: { kind: "file", path, ...range }, projectWorkspace: projectKey, sessionId: targetSession } }));
    } finally { attachPending.current = false; setAttaching(false); }
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
    if (mutationPending.current) return;
    await editor.current?.settleEdits();
    const file = filesRef.current.find(item => item.path === path);
    if (file?.saving) return;
    if (file && isDirty(file) && !window.confirm(`Discard unsaved edits to ${path}?`)) return;
    const remaining = filesRef.current.filter(item => item.path !== path);
    updateFiles(() => remaining);
    setActivePath(previous => previous === path ? remaining.at(-1)?.path : previous);
  };

  const closeFileMenu = useCallback((restoreFocus = false) => {
    setFileMenu(undefined);
    if (restoreFocus) menuOrigin.current?.focus();
  }, []);
  const showFileMenu = (origin: HTMLElement, target?: FileActionTarget, point?: { x: number; y: number }) => {
    if (mutationPending.current) return;
    const rect = origin.getBoundingClientRect();
    menuOrigin.current = origin;
    if (target) setSelectedEntry(target);
    setFileMenu({ target, x: point?.x ?? rect.left + 10, y: point?.y ?? rect.bottom, origin });
  };
  const menuKey = (event: React.KeyboardEvent<HTMLElement>, target?: FileActionTarget) => {
    if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
      event.preventDefault(); event.stopPropagation(); showFileMenu(event.currentTarget, target);
    } else if (target && !event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "F2" || event.key === "Delete")) {
      event.preventDefault(); event.stopPropagation(); menuOrigin.current = event.currentTarget;
      beginFileOperation(event.key === "F2" ? "rename" : "delete", target);
    }
  };
  const refreshOperationInfo = async (targetOperation: FileOperation) => {
    if (!targetOperation.target) return;
    const token = scope.current;
    setOperationLoading(true); setOperationError(""); setOperationInfo(undefined);
    try {
      await editor.current?.settleEdits();
      if (!token.active || scope.current !== token || operationRef.current !== targetOperation) return;
      const info = await api<FileInfo>(`/api/files/info?path=${encodeURIComponent(targetOperation.target.path)}`);
      if (token.active && scope.current === token && operationRef.current === targetOperation) setOperationInfo(info);
    } catch (error) {
      if (token.active && scope.current === token && operationRef.current === targetOperation) setOperationError(errorMessage(error));
    } finally {
      if (token.active && scope.current === token && operationRef.current === targetOperation) setOperationLoading(false);
    }
  };
  const beginFileOperation = (kind: FileOperation["kind"], target?: FileActionTarget) => {
    if (mutationPending.current) return;
    setFileMenu(undefined); setSearchMode(false);
    const isCreate = kind.startsWith("create-");
    const next: FileOperation = { kind, target: isCreate ? undefined : target, parent: isCreate && target?.kind === "directory" ? target.path : target ? parentPath(target.path) : "" };
    if (!isCreate && !target) return;
    operationRef.current = next; setOperation(next);
    setOperationName(kind === "rename" && target ? fileName(target.path) : "");
    setOperationInfo(undefined); setOperationError(""); setOperationNotice(""); setOperationLoading(!isCreate);
    if (!isCreate) void refreshOperationInfo(next);
  };
  const cancelFileOperation = () => {
    if (mutationPending.current) return;
    operationRef.current = undefined; setOperation(undefined);
    menuOrigin.current?.focus();
  };
  const refreshFileTree = async (paths: Iterable<string> = expanded) => {
    const token = scope.current;
    directoryVersion.current++;
    setDirectories({}); setTreeError("");
    const results = await Promise.allSettled([...new Set(["", ...paths])].map(loadDirectory));
    const failed = results.find(result => result.status === "rejected");
    if (token.active && scope.current === token && failed?.status === "rejected") setTreeError(`Files changed, but a folder could not be refreshed: ${errorMessage(failed.reason)}`);
  };
  const submitFileOperation = async () => {
    const targetOperation = operationRef.current;
    if (!targetOperation || mutationPending.current || operationLoading) return;
    const token = scope.current;
    const isCurrent = () => token.active && scope.current === token && operationRef.current === targetOperation;
    const name = operationName.trim();
    if (targetOperation.kind !== "delete" && (!name || name === "." || name === ".." || /[\\/\u0000]/.test(name))) { setOperationError("Enter a name without slashes, or choose another name."); return; }
    mutationPending.current = true; fileReadVersion.current++; setLoading(""); setOperationBusy(true); setOperationError(""); setOperationNotice("");
    try {
      await editor.current?.settleEdits();
      if (!isCurrent()) return;
      const target = targetOperation.target;
      const affected = target ? filesRef.current.filter(file => withinPath(file.path, target.path)) : [];
      if (affected.some(file => file.saving)) { setOperationError("Wait for these files to finish saving, then try again."); return; }
      const dirty = affected.filter(isDirty);
      if (dirty.length) {
        for (const file of dirty) {
          if (!await saveFile(file.path)) {
            if (isCurrent()) { setActivePath(file.path); setOperationError(`Could not save ${file.path}. Your edits are still open. Cancel to resolve the conflict.`); }
            return;
          }
          if (!isCurrent()) return;
        }
        await refreshOperationInfo(targetOperation);
        if (isCurrent()) setOperationNotice(`Edits saved. Review this ${target?.kind === "directory" ? "folder" : "file"}, then confirm ${targetOperation.kind === "delete" ? "deletion" : "the new name"}.`);
        return;
      }
      if (targetOperation.kind.startsWith("create-")) {
        const path = [targetOperation.parent, name].filter(Boolean).join("/");
        const kind = targetOperation.kind === "create-directory" ? "directory" : "file";
        await api("/api/files/create", { path, kind });
        if (!isCurrent()) return;
        setSelectedEntry({ path, kind });
        const nextExpanded = new Set([...expanded, targetOperation.parent, ...(kind === "directory" ? [path] : [])]);
        setExpanded(nextExpanded);
        operationRef.current = undefined; setOperation(undefined);
        await refreshFileTree(nextExpanded);
        if (token.active && scope.current === token) {
          setFileNotice({ message: `${kind === "directory" ? "Folder" : "File"} created: ${path}` });
          if (kind === "file") await openFile(path, undefined, 1, true);
        }
      } else if (target && operationInfo) {
        if (targetOperation.kind === "rename") {
          const newPath = [targetOperation.parent, name].filter(Boolean).join("/");
          if (newPath === target.path) { setOperationError("Choose a different name."); return; }
          await api("/api/files/rename", { path: target.path, newPath, revision: operationInfo.revision });
          if (!isCurrent()) return;
          openRequest.current++;
          updateFiles(previous => previous.map(file => ({ ...file, path: remapPath(file.path, target.path, newPath) })));
          setActivePath(previous => previous ? remapPath(previous, target.path, newPath) : previous);
          if (lastTextPath.current) lastTextPath.current = remapPath(lastTextPath.current, target.path, newPath);
          setCursorTarget(previous => previous ? { ...previous, path: remapPath(previous.path, target.path, newPath) } : previous);
          setSelectedEntry({ ...target, path: newPath });
          const nextExpanded = new Set([...expanded].map(path => remapPath(path, target.path, newPath)));
          setExpanded(nextExpanded);
          operationRef.current = undefined; setOperation(undefined);
          await refreshFileTree(nextExpanded);
          if (token.active && scope.current === token) setFileNotice({ message: `Renamed to ${newPath}` });
        } else {
          const deleted = await api<{ trashId: string }>("/api/files/delete", { path: target.path, revision: operationInfo.revision });
          if (!isCurrent()) return;
          openRequest.current++;
          const remaining = filesRef.current.filter(file => !withinPath(file.path, target.path));
          updateFiles(() => remaining);
          setActivePath(previous => previous && withinPath(previous, target.path) ? remaining.at(-1)?.path : previous);
          if (lastTextPath.current && withinPath(lastTextPath.current, target.path)) lastTextPath.current = undefined;
          setCursorTarget(previous => previous && withinPath(previous.path, target.path) ? undefined : previous);
          setSelectedEntry(undefined);
          const nextExpanded = new Set([...expanded].filter(path => !withinPath(path, target.path)));
          setExpanded(nextExpanded);
          operationRef.current = undefined; setOperation(undefined);
          setFileNotice({ message: `Moved ${target.path} to recovery storage.`, path: target.path, trashId: deleted.trashId, openPaths: affected.map(file => file.path), expandedPaths: [...expanded].filter(path => withinPath(path, target.path)), activePath });
          await refreshFileTree(nextExpanded);
        }
      }
    } catch (error) { if (isCurrent()) setOperationError(errorMessage(error)); }
    finally { mutationPending.current = false; if (token.active && scope.current === token) setOperationBusy(false); }
  };
  const undoFileDelete = async () => {
    const notice = fileNotice;
    if (!notice?.trashId || mutationPending.current) return;
    const token = scope.current;
    mutationPending.current = true; fileReadVersion.current++; setLoading(""); setOperationBusy(true);
    try {
      await api("/api/files/restore", { trashId: notice.trashId });
      if (!token.active || scope.current !== token) return;
      const reopened: OpenFile[] = [];
      const reopenFailures: string[] = [];
      for (const path of notice.openPaths ?? []) {
        if (filesRef.current.some(file => file.path === path)) continue;
        if (imageFile(path)) reopened.push({ path, kind: "image", content: "", saved: "", revision: "" });
        else {
          try { const incoming = await api<TextFile>(`/api/files/content?path=${encodeURIComponent(path)}`); reopened.push({ path, kind: "text", content: incoming.content, saved: incoming.content, revision: incoming.revision }); }
          catch (error) {
            if (error instanceof ApiError && [413, 415].includes(error.status)) reopened.push({ path, kind: "binary", content: "", saved: "", revision: "", error: errorMessage(error) });
            else reopenFailures.push(path);
          }
        }
        if (!token.active || scope.current !== token) return;
      }
      updateFiles(previous => [...previous, ...reopened.filter(file => !previous.some(existing => existing.path === file.path))]);
      setActivePath(previous => previous ?? reopened.find(file => file.path === notice.activePath)?.path ?? reopened[0]?.path);
      const nextExpanded = new Set([...expanded, ...(notice.expandedPaths ?? []), ...(notice.path ? [parentPath(notice.path)] : [])]);
      setExpanded(nextExpanded);
      await refreshFileTree(nextExpanded);
      if (token.active && scope.current === token) setFileNotice({ message: `Restored ${notice.path}.`, error: reopenFailures.length ? `Could not reopen ${reopenFailures.join(", ")}; open ${reopenFailures.length === 1 ? "it" : "them"} from the file tree again.` : undefined });
    } catch (error) { if (token.active && scope.current === token) setFileNotice(previous => previous === notice ? { ...notice, error: errorMessage(error) } : previous); }
    finally { mutationPending.current = false; if (token.active && scope.current === token) setOperationBusy(false); }
  };
  const copyRelativePath = async (target: FileActionTarget) => {
    const token = scope.current;
    try { await navigator.clipboard.writeText(target.path); if (token.active && scope.current === token) setFileNotice({ message: `Copied ${target.path}` }); }
    catch (error) { if (token.active && scope.current === token) onError(`Could not copy the path: ${errorMessage(error)}`); }
  };

  useImperativeHandle(ref, () => ({ prepareToLeave: async () => {
    if (mutationPending.current) { onNeedsAttention(); return false; }
    await editor.current?.settleEdits();
    if (mutationPending.current) { onNeedsAttention(); return false; }
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
      if (mutationPending.current || filesRef.current.some(isDirty)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => () => { guardResult.current?.(false); }, []);

  const tree = (path: string, depth = 0): React.ReactNode => directories[path]?.entries.map(entry => <div key={entry.path}>
    <div className={`file-tree-row ${selectedEntry?.path === entry.path ? "selected" : ""}`} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); showFileMenu(event.currentTarget.querySelector<HTMLButtonElement>("button")!, entry, { x: event.clientX, y: event.clientY }); }}>
    <button className={`file-tree-entry ${entry.path === activePath ? "active" : ""}`} style={{ paddingLeft: 12 + depth * 14 }} aria-label={`${entry.kind === "directory" ? `${expanded.has(entry.path) ? "Collapse" : "Expand"} folder` : "Open file"}: ${entry.path}`} aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined} aria-haspopup="menu" title={entry.path} disabled={operationBusy} onKeyDown={event => menuKey(event, entry)} onClick={() => { setSelectedEntry(entry); void (entry.kind === "directory" ? toggleDirectory(entry.path) : openFile(entry.path)); }}>
      {entry.kind === "directory" ? <><Icon name="chevron" size={12} className={expanded.has(entry.path) ? "" : "project-collapsed"} /><Icon name="folder" size={14} /></> : <><span className="file-tree-indent" /><Icon name={imageFile(entry.path) ? "image" : "file"} size={14} /></>}
      <span>{entry.name}</span>{loading === entry.path && <span className="working-spinner" />}
    </button>
    <button type="button" className="file-row-actions" aria-label={`Actions for ${entry.path}`} aria-haspopup="menu" title={`Actions for ${entry.path}`} disabled={operationBusy} onKeyDown={event => menuKey(event, entry)} onClick={event => showFileMenu(event.currentTarget, entry)}><span aria-hidden="true">⋯</span></button>
    </div>
    {entry.kind === "directory" && expanded.has(entry.path) && tree(entry.path, depth + 1)}
  </div>);

  return <div className="files-panel">
    <aside className={`file-explorer ${searchMode ? "search-mode" : ""}`} aria-label="Project files" tabIndex={0} onContextMenu={event => { event.preventDefault(); showFileMenu(event.currentTarget, undefined, { x: event.clientX, y: event.clientY }); }} onKeyDown={event => menuKey(event)}><div className="file-explorer-heading"><strong title={projectName}>{projectName}</strong><button className="icon-button" title="Quick Open (⌘P / Ctrl+P)" aria-label="Quick Open" onClick={beginQuickOpen}><Icon name="file" size={14} /></button><button className="icon-button" title="Search in files (⌘⇧F / Ctrl+Shift+F)" aria-label={searchMode ? "Show file explorer" : "Search in files"} onClick={() => { setSearchMode(!searchMode); requestAnimationFrame(() => searchInput.current?.focus()); }}><Icon name={searchMode ? "folder" : "search"} size={14} /></button><button className="icon-button" title="Refresh files" aria-label="Refresh files" disabled={operationBusy} onClick={() => void refreshFileTree()}><Icon name="reconnect" size={14} /></button></div>
      <div className="file-explorer-create"><button type="button" aria-label="New file" title={`New file in ${selectedEntry?.kind === "directory" ? selectedEntry.path : selectedEntry ? parentPath(selectedEntry.path) || "project root" : "project root"}`} disabled={operationBusy} onClick={() => beginFileOperation("create-file", selectedEntry)}><Icon name="file" size={12} />New file</button><button type="button" aria-label="New folder" title={`New folder in ${selectedEntry?.kind === "directory" ? selectedEntry.path : selectedEntry ? parentPath(selectedEntry.path) || "project root" : "project root"}`} disabled={operationBusy} onClick={() => beginFileOperation("create-directory", selectedEntry)}><Icon name="folder" size={12} />New folder</button></div>
      {searchMode ? <div className="workspace-search"><div className="workspace-search-input"><Icon name="search" size={13} /><input ref={searchInput} aria-label="Search in files" placeholder="Search project contents" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} /></div><div className="workspace-search-options"><button aria-label="Match case" aria-pressed={searchCase} title="Match case" onClick={() => setSearchCase(!searchCase)}>Aa</button><button aria-label="Match whole word" aria-pressed={searchWholeWord} title="Match whole word" onClick={() => setSearchWholeWord(!searchWholeWord)}>Ab</button><button aria-label="Use regular expression" aria-pressed={searchRegex} title="Use regular expression" onClick={() => setSearchRegex(!searchRegex)}>.*</button>{searchBusy && <span className="working-spinner" />}</div>{searchError && <p className="file-tree-note file-error" role="alert">{searchError}</p>}{searchQuery.trim() && !searchBusy && !searchError && <p className="workspace-search-count">{searchMatches.length} {searchMatches.length === 1 ? "match" : "matches"}{searchTruncated ? " · narrow your search for more" : ""}</p>}<div className="workspace-search-results">{searchMatches.map((match, index) => <button key={`${match.path}:${match.line}:${match.column}:${index}`} aria-label={`Open search result: ${match.path}:${match.line}:${match.column}`} title={`${match.path}:${match.line}`} onClick={() => void openFile(match.path, match.line, match.column)}><span>{match.path}</span><small><i>{match.line}</i>{match.text}</small></button>)}</div>{!searchQuery.trim() && <p className="file-tree-note">Search text across this project.<br />⌘⇧F / Ctrl+Shift+F</p>}</div> : <div className="file-tree">{tree("")}{directories[""]?.entries.length === 0 && <p className="file-tree-note">This folder is empty.</p>}{directories[""]?.truncated && <p className="file-tree-note">Showing the first 1,000 entries.</p>}{treeError && <p className="file-tree-note file-error" role="alert">{treeError}</p>}</div>}
      {fileNotice && <div className="file-operation-result" role="status"><p>{fileNotice.message}</p>{fileNotice.trashId && <button type="button" aria-label="Undo delete" disabled={operationBusy} onClick={() => void undoFileDelete()}>{operationBusy ? "Restoring…" : "Undo"}</button>}<button type="button" aria-label="Dismiss file notification" disabled={operationBusy} onClick={() => setFileNotice(undefined)}>Dismiss</button>{fileNotice.error && <p className="file-error" role="alert">{fileNotice.error}</p>}</div>}
    </aside>
    <div className="file-workspace">
      {files.length > 0 && <div className="file-tabs" role="tablist" aria-label="Open files">{files.map(file => <div className={`file-tab ${activePath === file.path ? "active" : ""}`} key={file.path}><button role="tab" aria-selected={activePath === file.path} title={file.path} onClick={() => void openFile(file.path)}>{isDirty(file) && <span className="file-dirty-dot" />}<span>{fileName(file.path)}</span></button><button aria-label={`Close file: ${file.path}`} onClick={() => closeFile(file.path)}><Icon name="close" size={12} /></button></div>)}</div>}
      {current ? <>
        <div className="file-editor-toolbar"><span title={current.path}>{current.path}</span><div>{current.kind === "text" && <><button className="toolbar-button" aria-label="Attach to chat" title={`${isDirty(current) ? "Save and attach" : "Attach"} ${selection ? `lines ${selection.startLine}–${selection.endLine}` : "file"} to chat (⌘⇧A / Ctrl+Shift+A)`} disabled={attaching || current.saving || savingAll || !!loading || !editor.current} onClick={() => void attachFile(current.path, editor.current?.getSelection())}><Icon name="plus" size={14} />{attaching ? "Attaching…" : "Attach to chat"}</button><button className="toolbar-button" aria-label="Vim key bindings" aria-pressed={vimEnabled} title={vimEnabled ? "Disable Vim key bindings" : "Enable Vim key bindings"} disabled={vimSettingsBusy} onClick={() => void toggleVim()}>Vim {vimEnabled ? "on" : "off"}</button><button className="toolbar-button" aria-label="Find in file" title="Find in file (⌘F / Ctrl+F)" onClick={() => editor.current?.find()}><Icon name="search" size={14} /></button><button className="toolbar-button" aria-label="Editor commands" title="Editor commands (⌘⇧P / Ctrl+Shift+P)" onClick={() => editor.current?.commandPalette()}><Icon name="settings" size={14} /></button></>}<button className="toolbar-button" aria-label="Reload file" title="Reload file from disk" disabled={current.kind === "binary" || current.saving || !!loading} onClick={() => void reloadFile(current.path)}><Icon name="reconnect" size={14} /></button>{current.kind === "text" && <button className="file-save" disabled={!isDirty(current) || current.saving} onClick={() => void saveFile(current.path)}><Icon name="save" size={14} />{current.saving ? "Saving…" : "Save file"}</button>}</div></div>
        {current.error && current.kind === "text" && <div className="file-conflict" role="alert"><Icon name="warning" size={15} /><span>{current.error} Your edits are still here.</span></div>}
        <div className="file-code-surface" hidden={current.kind !== "text"}>{editorFile && <Suspense fallback={<div className="panel-empty"><span className="working-spinner" /><p>Opening editor…</p></div>}><CodeEditor ref={editor} onError={onError} path={editorFile.path} projectKey={projectKey} content={editorFile.content} vimEnabled={vimEnabled} readOnly={current.kind !== "text" || !!editorFile.saving || savingAll || operationBusy || loading === editorFile.path} openPaths={files.filter(file => file.kind === "text").map(file => file.path)} onChange={content => updateFiles(previous => previous.map(file => file.path === editorFile.path ? { ...file, content } : file))} onSave={() => void saveFile(editorFile.path)} onCursorChange={setCursor} onSelectionChange={setSelection} onAttachSelection={range => void attachFile(editorFile.path, range)} onReady={editorReady} /></Suspense>}</div>
        {current.kind === "text" ? <footer className="file-editor-footer"><span>{isDirty(current) ? "Unsaved changes" : "Saved"}</span><span>Ln {cursor.line}, Col {cursor.column}<span className="file-footer-separator">·</span>UTF-8</span></footer> : current.kind === "image" ? <div className="file-image-preview"><img src={apiPath(`/api/files/raw?path=${encodeURIComponent(current.path)}&v=${current.revision}`)} alt={current.path} /></div> : <div className="panel-empty"><Icon name="file" size={28} /><h2>{fileName(current.path)}</h2><p>{current.error || "Download this file to open it in another app."}</p><a className="panel-primary" href={apiPath(`/api/files/raw?path=${encodeURIComponent(current.path)}`)} download={fileName(current.path)}><Icon name="download" size={15} />Download file</a></div>}
      </> : <div className="panel-empty"><Icon name="folder" size={30} /><h2>Your project files</h2><p>Open a file with ⌘P or Ctrl+P.<br />Search this project with ⌘⇧F or Ctrl+Shift+F.</p><button className="panel-primary" onClick={beginQuickOpen}><Icon name="search" size={14} />Quick Open</button></div>}
    </div>
    <dialog ref={quickDialog} className="quick-open-dialog" aria-label="Quick Open" onCancel={() => setQuickOpen(false)} onClose={() => setQuickOpen(false)}><div className="quick-open-input"><Icon name="search" size={16} /><input ref={quickInput} aria-label="Search files by name" placeholder="Search files by name…" value={quickQuery} onChange={event => setQuickQuery(event.target.value)} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setQuickSelected(previous => Math.min(Math.max(0, previous + (event.key === "ArrowDown" ? 1 : -1)), Math.max(0, quickResults.length - 1))); }
      else if (event.key === "Enter" && !quickBusy) { event.preventDefault(); chooseQuickFile(quickResults[quickSelected]); }
    }} />{quickBusy && <span className="working-spinner" />}</div><div className="quick-open-results" role="listbox" aria-label="Matching files">{quickResults.map((file, index) => <button key={file.path} role="option" aria-selected={index === quickSelected} disabled={quickBusy} onClick={() => chooseQuickFile(file)}><Icon name="file" size={15} /><strong>{file.name}</strong><span>{file.path}</span></button>)}{!quickBusy && !quickResults.length && !quickError && <p>No matching files.</p>}{quickError && <p className="file-error" role="alert">{quickError}</p>}</div><footer>↑↓ to select · Enter to open · Esc to close{quickTruncated ? " · Type to narrow results" : ""}</footer></dialog>
    {fileMenu && <FileActionMenu menu={fileMenu} onClose={closeFileMenu} onAction={beginFileOperation} onCopy={target => void copyRelativePath(target)} />}
    {operation && <FileOperationDialog key={`${operation.kind}:${operation.target?.path ?? operation.parent}`} operation={operation} name={operationName} info={operationInfo} dirtyPaths={operation.target ? files.filter(file => withinPath(file.path, operation.target!.path) && isDirty(file)).map(file => file.path) : []} busy={operationBusy} loading={operationLoading} error={operationError} notice={operationNotice} onName={setOperationName} onCancel={cancelFileOperation} onSubmit={() => void submitFileOperation()} onRefresh={() => { setOperationNotice(""); void refreshOperationInfo(operation); }} />}
    <dialog ref={guardDialog} className="project-dialog" aria-label="Unsaved file changes" onCancel={event => { if (savingAll) event.preventDefault(); else finishGuard(false); }}>
      <h2>Unsaved file changes</h2><p>{files.filter(isDirty).length} {files.filter(isDirty).length === 1 ? "file has" : "files have"} unsaved edits. Save them before leaving this project?</p>
      {guardError && <p className="project-dialog-error" role="alert">{guardError}</p>}
      <div className="project-dialog-actions"><button disabled={savingAll} onClick={() => finishGuard(false)}>Cancel</button><button disabled={savingAll} onClick={() => { updateFiles(previous => previous.map(file => ({ ...file, content: file.saved }))); finishGuard(true); }}>Discard changes</button><button className="button-dark" disabled={savingAll} onClick={() => void saveAndLeave()}>{savingAll ? "Saving…" : "Save and switch"}</button></div>
    </dialog>
  </div>;
});
