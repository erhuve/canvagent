import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import "./FileActions.css";

export type FileActionTarget = { path: string; kind: "file" | "directory" };
export type FileMenuState = { target?: FileActionTarget; x: number; y: number; origin: HTMLElement };
export type FileOperation = { kind: "create-file" | "create-directory" | "rename" | "delete"; target?: FileActionTarget; parent: string };
export type FileInfo = { path: string; name: string; kind: "file" | "directory"; revision: string; size: number; entries: number };

export function FileContextMenu({ menu, label, onClose, children }: {
  menu: Pick<FileMenuState, "x" | "y" | "origin">;
  label: string;
  onClose(restoreFocus?: boolean): void;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    node.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!element.current?.contains(event.target as Node)) onClose(false); };
    const resize = () => onClose(true);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", dismiss); window.removeEventListener("resize", resize); };
  }, [onClose]);
  return createPortal(<div ref={element} className="file-actions-menu" role="menu" aria-label={label} style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    const buttons = [...(element.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); onClose(true); }
  }}>
    {children}
  </div>, document.body);
}

export function FileActionMenu({ menu, onClose, onAction, onCopy }: {
  menu: FileMenuState;
  onClose(restoreFocus?: boolean): void;
  onAction(kind: FileOperation["kind"], target?: FileActionTarget): void;
  onCopy(target: FileActionTarget): void;
}) {
  const choose = (kind: FileOperation["kind"]) => { onClose(false); onAction(kind, menu.target); };
  const item = (label: string, icon: string, action: () => void, danger = false): ReactNode => <button type="button" role="menuitem" className={danger ? "file-action-danger" : undefined} onClick={action}><Icon name={icon} size={14} /><span>{label}</span></button>;
  return <FileContextMenu menu={menu} label={menu.target ? `File actions: ${menu.target.path}` : "Project file actions"} onClose={onClose}>
    {item("New file…", "file", () => choose("create-file"))}
    {item("New folder…", "folder", () => choose("create-directory"))}
    {menu.target && <><div role="separator" />{item("Rename…", "compose", () => choose("rename"))}{item("Copy relative path", "copy", () => { onClose(true); onCopy(menu.target!); })}<div role="separator" />{item("Delete…", "close", () => choose("delete"), true)}</>}
  </FileContextMenu>;
}

export function FileOperationDialog({ operation, name, info, dirtyPaths, busy, loading, error, notice, onName, onCancel, onSubmit, onRefresh }: {
  operation: FileOperation;
  name: string;
  info?: FileInfo;
  dirtyPaths: string[];
  busy: boolean;
  loading: boolean;
  error: string;
  notice: string;
  onName(name: string): void;
  onCancel(): void;
  onSubmit(): void;
  onRefresh(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const isCreate = operation.kind.startsWith("create-");
  const isDelete = operation.kind === "delete";
  const folder = operation.kind === "create-directory" || operation.target?.kind === "directory";
  const title = isCreate ? `New ${folder ? "folder" : "file"}` : `${isDelete ? "Delete" : "Rename"} ${folder ? "folder" : "file"}`;
  const action = isCreate ? "Create" : isDelete ? "Delete" : "Rename";
  useEffect(() => {
    dialog.current?.showModal();
    if (input.current) {
      input.current.focus();
      const dot = name.lastIndexOf(".");
      input.current.setSelectionRange(0, !folder && dot > 0 ? dot : name.length);
    }
    return () => { dialog.current?.close(); };
  }, []);
  return <dialog ref={dialog} className="project-dialog file-operation-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!busy && !loading && (isCreate || info)) onSubmit(); }}>
      <h2>{title}</h2>
      {isDelete ? <><p>Move <strong>{operation.target?.path}</strong>{folder ? " and everything inside it" : ""} to Canvagent recovery storage? You can undo this after deleting.</p>{info && folder && <p className="file-operation-meta">{info.entries} {info.entries === 1 ? "item" : "items"} inside · {new Intl.NumberFormat().format(info.size)} bytes</p>}</> : <><label htmlFor="file-operation-name">Name</label><input ref={input} id="file-operation-name" aria-label="Name" value={name} onChange={event => onName(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} maxLength={255} /><p className="file-operation-meta">{isCreate ? "Create in" : "Inside"} <strong>{operation.parent || "project root"}</strong></p></>}
      {!!dirtyPaths.length && <div className="file-operation-unsaved"><p>{dirtyPaths.length === 1 ? "This open file has" : `${dirtyPaths.length} open files have`} unsaved edits. Save them before {isDelete ? "deleting" : "renaming"}.</p><ul>{dirtyPaths.map(path => <li key={path}>{path}</li>)}</ul></div>}
      {loading && <p role="status" className="file-operation-status"><span className="working-spinner" />Checking files…</p>}
      {notice && <p role="status" className="file-operation-status">{notice}</p>}
      {error && <div className="project-dialog-error" role="alert"><p>{error}</p>{!isCreate && <button type="button" className="file-operation-refresh" disabled={busy || loading} onClick={onRefresh}>Refresh file details</button>}</div>}
      <div className="project-dialog-actions"><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" className={isDelete ? "file-delete-confirm" : "button-dark"} disabled={busy || loading || (!isCreate && !info) || (!isDelete && !name.trim())}>{busy ? "Working…" : dirtyPaths.length ? `Save and ${action.toLowerCase()}` : action}</button></div>
    </form>
  </dialog>;
}
