import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { FilesPanel, type FilesPanelHandle } from "./FilesPanel";
import { BrowserPanel } from "./BrowserPanel";
import { Icon } from "./icons";

const TerminalPanel = lazy(() => import('./TerminalPanel').then(module => ({ default: module.TerminalPanel })));

export type RightPanelHandle = FilesPanelHandle;
export const RightPanel = forwardRef<RightPanelHandle, { children: ReactNode; projectName: string; projectKey: string; onError: (message: string) => void }>(function RightPanel({ children, projectName, projectKey, onError }, ref) {
  const [tab, setTab] = useState<"canvas" | "browser" | "files">("canvas");
  const [filesVisited, setFilesVisited] = useState(false);
  const [fileCommand, setFileCommand] = useState<{ id: number; kind: "open" | "find" | "search" | "palette" }>();
  const [terminalOpen, setTerminalOpen] = useState(() => { try { return sessionStorage.getItem(`canvagent:terminal-open:${projectKey}`) === 'true'; } catch { return false; } });
  const [terminalVisited, setTerminalVisited] = useState(terminalOpen);
  const [terminalHeight, setTerminalHeight] = useState(() => { try { const saved = Number(localStorage.getItem(`canvagent:terminal-height:${projectKey}`)); return saved >= 140 ? Math.min(saved, 600) : 260; } catch { return 260; } });
  const files = useRef<FilesPanelHandle>(null);
  useEffect(() => { try { sessionStorage.setItem(`canvagent:terminal-open:${projectKey}`, String(terminalOpen)); } catch { /* Optional preference. */ } }, [terminalOpen, projectKey]);
  useImperativeHandle(ref, () => ({ prepareToLeave: async () => files.current?.prepareToLeave() ?? true }));
  useEffect(() => {
    const command = (kind: "open" | "find" | "search" | "palette") => {
      setFilesVisited(true); setTab("files");
      setFileCommand(previous => ({ id: (previous?.id ?? 0) + 1, kind }));
    };
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === 'Backquote' && !event.altKey) {
        event.preventDefault(); event.stopPropagation();
        setTerminalVisited(true); setTerminalOpen(previous => !previous);
        return;
      }
      const primaryModifier = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (!primaryModifier || event.altKey) return;
      const name = event.key.toLowerCase();
      if (name === "p" || name === "f" && (event.shiftKey || tab === "files")) {
        event.preventDefault(); event.stopPropagation();
        command(name === "p" ? event.shiftKey ? "palette" : "open" : event.shiftKey ? "search" : "find");
      }
    };
    const open = () => command("open"); const find = () => command("find");
    const search = () => command("search"); const palette = () => command("palette");
    const terminal = () => { setTerminalVisited(true); setTerminalOpen(previous => !previous); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("canvagent:quick-open", open); window.addEventListener("canvagent:find-file", find);
    window.addEventListener("canvagent:search-files", search); window.addEventListener("canvagent:editor-commands", palette);
    window.addEventListener('canvagent:toggle-terminal', terminal);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("canvagent:quick-open", open); window.removeEventListener("canvagent:find-file", find);
      window.removeEventListener("canvagent:search-files", search); window.removeEventListener("canvagent:editor-commands", palette);
      window.removeEventListener('canvagent:toggle-terminal', terminal);
    };
  }, [tab]);
  return <section className="right-panel" aria-label="Project workspace">
    <div className="panel-tabs" role="tablist" aria-label="Workspace panels">{([['canvas', 'board', 'Canvas'], ['browser', 'globe', 'Browser'], ['files', 'folder', 'Files']] as const).map(([id, icon, name]) => <button key={id} id={`panel-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => { setTab(id); if (id === "files") setFilesVisited(true); }}><Icon name={icon} size={15} />{name}</button>)}<span className="panel-tabs-project" title={projectName}>{projectName}</span><button className="panel-terminal-toggle" aria-label="Toggle terminal" title="Terminal (Ctrl+`)" aria-pressed={terminalOpen} onClick={() => { setTerminalVisited(true); setTerminalOpen(previous => !previous); }}><Icon name="terminal" size={15} /><span>Terminal</span></button></div>
    <div id="panel-canvas" className="panel-view" role="tabpanel" aria-labelledby="panel-tab-canvas" hidden={tab !== "canvas"}>{children}</div>
    <div id="panel-browser" className="panel-view" role="tabpanel" aria-labelledby="panel-tab-browser" hidden={tab !== "browser"}><BrowserPanel active={tab === "browser"} projectKey={projectKey} /></div>
    <div id="panel-files" className="panel-view" role="tabpanel" aria-labelledby="panel-tab-files" hidden={tab !== "files"}>{filesVisited && <FilesPanel ref={files} active={tab === "files"} projectName={projectName} projectKey={projectKey} command={fileCommand} onError={onError} onNeedsAttention={() => setTab("files")} />}</div>
    {terminalVisited && <Suspense fallback={terminalOpen ? <div className="terminal-loading" style={{ height: terminalHeight }} role="status">Opening terminal…</div> : null}><TerminalPanel active={terminalOpen} projectKey={projectKey} height={terminalHeight} onHeightChange={height => { setTerminalHeight(height); try { localStorage.setItem(`canvagent:terminal-height:${projectKey}`, String(height)); } catch { /* Optional preference. */ } }} onHide={() => setTerminalOpen(false)} /></Suspense>}
  </section>;
});
