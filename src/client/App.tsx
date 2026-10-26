import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { api, apiPath, hostApi, projectBasePath, errorMessage } from "./api";
import { Icon } from "./icons";
import { ChatWorkspace } from "./ChatWorkspace";
import { RightPanel, type RightPanelHandle } from "./RightPanel";
import { ConversationFiles } from './ConversationFiles';
import { desktopInvoke, hasDesktopBridge } from "./desktop";
import { useBoard } from "./useBoard";
import { useNotifications } from "./useNotifications";
import { CanvasWebsiteTools, useCanvasWebsites, validateCanvasWebsite } from './CanvasWebsites';
import type { AppState, Approval, ProjectSummary } from "./types";
import { canAcceptEmptyElicitation } from "../shared/elicitation";
import type { AgentSettings } from "../shared/settings";

function ApprovalCard({ approval, sessionId, onError }: { approval: Approval; sessionId: string; onError: (message: string) => void }) {
  const [deciding, setDeciding] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const command = approval.command || approval.item?.command || approval.params?.command;
  const questions: any[] = approval.params?.questions || [];
  const choices: string[] = approval.choices || ["accept", "decline"];
  const elicitation = approval.method === "mcpServer/elicitation/request";
  const labels: Record<string, string> = { accept: "Approve once", acceptForSession: "Approve for session", decline: "Deny", cancel: elicitation ? "Cancel request" : "Stop turn", answer: "Send answers" };
  const decide = async (decision: string) => {
    setDeciding(true);
    try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approval.id)}`, { decision, requestId: crypto.randomUUID(), ...(decision === "answer" ? { answers: Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id]?.trim() || ""] }])) } : {}) }); }
    catch (error) { onError(errorMessage(error)); setDeciding(false); }
  };
  return <div className="approval-card">
    <div className="approval-heading"><Icon name="warning" size={16} /><strong>{approval.title || "Your approval is needed"}</strong></div>
    <p>{approval.description || approval.reason || "Codex is requesting permission to continue this operation."}</p>
    {elicitation && typeof approval.params?._meta?.subtitle === "string" && <p>{approval.params._meta.subtitle}</p>}
    {elicitation && !canAcceptEmptyElicitation(approval.params || {}) && <p role="status">This request needs a form or verification flow that Canvagent cannot display yet. You can deny or cancel the request.</p>}
    {command && <pre>{Array.isArray(command) ? command.join(" ") : command}</pre>}
    {approval.params?.permissions && <pre>{JSON.stringify(approval.params.permissions, null, 2)}</pre>}
    {(approval.cwd || approval.params?.cwd) && <span className="approval-cwd">{approval.cwd || approval.params.cwd}</span>}
    {questions.map(question => <fieldset className="agent-question" key={question.id}><legend>{question.question || question.header || "Your answer"}</legend>{question.options?.map((option: any) => <label key={option.label}><input type="radio" name={`${approval.id}-${question.id}`} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}<input className="question-custom-answer" aria-label={`Answer: ${question.question || question.id}`} placeholder={question.options?.length ? "Or write an answer…" : "Your answer…"} type={question.isSecret ? "password" : "text"} value={question.options?.some((option: any) => option.label === answers[question.id]) ? "" : answers[question.id] || ""} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} /></fieldset>)}
    <div className="approval-actions">{choices.map(choice => <button key={choice} className={choice === "accept" || choice === "answer" ? "button-dark" : ""} onClick={() => void decide(choice)} disabled={deciding || (choice === "answer" && (!questions.length || questions.some(question => !answers[question.id]?.trim())))}>{deciding ? "Sending…" : labels[choice] || choice}</button>)}</div>
  </div>;
}

export default function App() {
  const [state, setState] = useState<AppState>();
  const panel = useRef<RightPanelHandle>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [projectError, setProjectError] = useState("");
  const projectDialog = useRef<HTMLDialogElement>(null);
  const navigationBusy = useRef(false);
  const requestedSession = useRef(new URLSearchParams(location.search).get("session"));
  const [online, setOnline] = useState(false);
  const [initialError, setInitialError] = useState("");
  const [toast, setToast] = useState("");
  const [draftRequest, setDraftRequest] = useState<{ id: number; text: string }>();
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState(false);
  const latestRuntime = useRef<AppState['runtime']>();
  const automaticConnectionAttempted = useRef(false);
  const connectionRequest = useRef<Promise<void>>();
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [notices, setNotices] = useState<Record<string, { id: string; text: string }>>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const sendingRef = useRef(new Set<string>());
  const desktopBusy = useRef(false);
  const submissions = useRef(new Map<string, { key: string; requestId: string }>());
  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6500);
  }, []);
  const canvas = useBoard(notify);
  const websites = useCanvasWebsites();
  const bindCanvas = useCallback((api: any) => { canvas.bindEditor(api); websites.bindEditor(api); }, [canvas.bindEditor, websites.bindEditor]);
  const onCanvasChange = useCallback((elements: readonly any[], appState: any, files: Record<string, any>) => {
    canvas.onChange(elements, appState, files);
    websites.onChange(elements, appState);
  }, [canvas.onChange, websites.onChange]);
  const boardReceiver = useRef(canvas.receiveBoard);
  boardReceiver.current = canvas.receiveBoard;
  const captureHandler = useRef(canvas.capture);
  captureHandler.current = canvas.capture;

  const applyState = useCallback((incoming: AppState) => {
    latestRuntime.current = incoming.runtime;
    setState(incoming);
    boardReceiver.current(incoming.board);
    setInitialError("");
  }, []);

  const connectRuntime = useCallback(() => {
    if (connectionRequest.current) return connectionRequest.current;
    setConnecting(true);
    const request = (async () => {
      try {
        await api("/api/runtime/connect", {});
        applyState(await api<AppState>("/api/state"));
      } catch (error) { notify(errorMessage(error)); }
      finally { connectionRequest.current = undefined; setConnecting(false); }
    })();
    connectionRequest.current = request;
    return request;
  }, [applyState, notify]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const boot = async () => {
      try {
        let incoming = await api<AppState>("/api/state");
        if (!disposed && requestedSession.current) {
          const id = requestedSession.current;
          requestedSession.current = null;
          if (incoming.sessions.some(item => item.id === id)) {
            await api(`/api/sessions/${encodeURIComponent(id)}/activate`, {});
            incoming = await api<AppState>("/api/state");
          }
          history.replaceState(null, "", location.pathname);
        }
        if (!disposed) applyState(incoming);
      }
      catch (error) { if (!disposed) setInitialError(errorMessage(error)); }
      if (!disposed) connect();
    };
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${apiPath("/api/events")}`);
      socket.onopen = () => {
        attempts = 0; setOnline(true);
        if (!automaticConnectionAttempted.current) {
          automaticConnectionAttempted.current = true;
          const runtime = latestRuntime.current;
          if (!runtime?.connected || !runtime.authenticated) void connectRuntime();
        }
      };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "state") applyState(message.state);
          else if (message.type === "board") boardReceiver.current(message.board, message.mutation);
          else if (message.type === "runtime") { latestRuntime.current = message.runtime; setState(previous => previous ? { ...previous, runtime: message.runtime } : previous); }
          else if (message.type === "session") { const activity = [...(message.session.activities || [])].reverse().find((entry: any) => entry.kind === "canvas" && entry.title?.startsWith("Canvas revision")); if (activity) setNotices(previous => previous[message.session.id]?.id === activity.id ? previous : { ...previous, [message.session.id]: { id: activity.id, text: activity.title } }); setState(previous => {
            if (!previous) return previous;
            const exists = previous.sessions.some(session => session.id === message.session.id);
            return { ...previous, sessions: exists ? previous.sessions.map(session => session.id === message.session.id ? message.session : session) : [...previous.sessions, message.session], activeSessionId: message.activeSessionId ?? previous.activeSessionId };
          }); }
          else if (message.type === "capture") void captureHandler.current(message);
          else if (message.type === "notice" || message.type === "canvas_notice") notify(message.message || message.text || "Canvas changes shared with the agent.");
          else if (message.type === "artifacts") setState(previous => previous ? { ...previous, artifacts: message.artifacts } : previous);
        } catch { /* Ignore malformed events; reconnect always obtains a full snapshot. */ }
      };
      socket.onclose = () => {
        if (disposed) return;
        setOnline(false);
        reconnect = setTimeout(() => void boot(), Math.min(8000, 700 * 2 ** attempts++));
      };
      socket.onerror = () => socket?.close();
    };
    void boot();
    return () => { disposed = true; clearTimeout(reconnect); socket?.close(); };
  }, [applyState, connectRuntime, notify]);

  useEffect(() => {
    let disposed = false;
    const refreshProjects = async () => {
      try {
        const incoming = await hostApi<{ projects: ProjectSummary[]; activeProjectId: string }>("/api/projects");
        if (!disposed) {
          if (!projectBasePath) location.replace(`/projects/${encodeURIComponent(incoming.activeProjectId)}/`);
          else setProjects(incoming.projects);
        }
      } catch { /* Keep the known projects available while the service reconnects. */ }
    };
    void refreshProjects();
    const timer = setInterval(() => void refreshProjects(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!state?.project.workspace) return;
    document.title = `${state.project.name} — Canvagent`;
    if (hasDesktopBridge()) void desktopInvoke('remember_workspace', { workspace: state.project.workspace }).catch(() => undefined);
  }, [state?.project.workspace, state?.project.name]);

  useEffect(() => {
    if (projectPickerOpen) projectDialog.current?.showModal();
    else projectDialog.current?.close();
  }, [projectPickerOpen]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (canvas.saveStatus !== "saved") { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [canvas.saveStatus]);

  const session = state?.sessions.find(candidate => candidate.id === state.activeSessionId) || state?.sessions.at(-1);
  const sending = !!session && sendingIds.has(session.id);
  const currentBoard = canvas.board || state?.board;
  const visibleElementCount = canvas.elementCount;

  const refresh = async () => { const incoming = await api<AppState>("/api/state"); applyState(incoming); return incoming; };

  const createSession = async () => {
    setSessionBusy(true);
    try {
      if (!await canvas.flush()) throw new Error("Save or resolve your canvas edits before starting another conversation.");
      const result = await api<any>("/api/sessions", {});
      const incoming = await refresh();
      return result.session || incoming.sessions.find(candidate => candidate.id === incoming.activeSessionId) || incoming.sessions.at(-1);
    } catch (error) { notify(errorMessage(error)); return undefined; }
    finally { setSessionBusy(false); }
  };

  const activateSession = async (id: string) => {
    setSessionBusy(true);
    try {
      if (!await canvas.flush()) throw new Error("Save or resolve your canvas edits before changing conversations.");
      await api(`/api/sessions/${encodeURIComponent(id)}/activate`, {});
      await refresh();
    } catch (error) { notify(errorMessage(error)); }
    finally { setSessionBusy(false); }
  };

  const send = async (text: string) => {
    if (!text.trim()) return;
    if (!online) throw new Error("Reconnect to the local service before sending.");
    let target = session;
    if (!target) target = await createSession();
    if (!target) throw new Error("Could not open a conversation. Your message is still available to retry.");
    const targetId = target.id;
    const selectedIds = [...canvas.selectedIds];
    if (sendingRef.current.has(targetId)) throw new Error("A message is already being submitted in this conversation. Try again in a moment.");
    sendingRef.current.add(targetId);
    setSendingIds(new Set(sendingRef.current));
    try {
      if (!await canvas.flush()) throw new Error("Your message is ready. Resolve the canvas save first so the agent receives the right version.");
      const key = JSON.stringify([targetId, text.trim(), selectedIds]);
      if (submissions.current.get(targetId)?.key !== key) submissions.current.set(targetId, { key, requestId: crypto.randomUUID() });
      await api(`/api/sessions/${encodeURIComponent(targetId)}/messages`, { text: text.trim(), requestId: submissions.current.get(targetId)!.requestId, selection: { elementIds: selectedIds } });
      submissions.current.delete(targetId);
    } finally { sendingRef.current.delete(targetId); setSendingIds(new Set(sendingRef.current)); }
  };

  const interrupt = async () => {
    if (!session) return;
    try { await api(`/api/sessions/${encodeURIComponent(session.id)}/interrupt`, {}); }
    catch (error) { notify(errorMessage(error)); }
  };

  const changeSettings = async (settings: Partial<AgentSettings>, remember = false) => {
    if (!session) throw new Error("Open a conversation before changing settings.");
    const targetId = session.id;
    setSettingsSaving(true);
    try {
      const updated = await api<AppState['sessions'][number]>(`/api/sessions/${encodeURIComponent(targetId)}/settings${remember ? '?remember=true' : ''}`, settings);
      setState(previous => previous ? { ...previous, sessions: previous.sessions.map(item => item.id === targetId ? { ...item, settings: updated.settings } : item) } : previous);
    } finally { setSettingsSaving(false); }
  };
  const saveDefaultSettings = async (settings: AgentSettings) => {
    setSettingsSaving(true);
    try {
      const runtime = await api<AppState['runtime']>("/api/settings", settings);
      setState(previous => previous ? { ...previous, runtime: { ...previous.runtime, model: runtime.model, settings: runtime.settings } } : previous);
      notify("Defaults saved for new conversations.");
    } finally { setSettingsSaving(false); }
  };

  const askSelection = () => {
    setDraftRequest(previous => ({ id: (previous?.id ?? 0) + 1, text: "Help me work on the selected part of the canvas." }));
  };

  const navigateProject = async (id: string, sessionId?: string) => {
    if (navigationBusy.current) return;
    if (id === projectBasePath.split("/").at(-1)) {
      if (sessionId) await activateSession(sessionId);
      return;
    }
    navigationBusy.current = true;
    setProjectBusy(true);
    try {
      if (sendingRef.current.size) throw new Error("Wait for your message to finish submitting before changing projects.");
      if (!await canvas.flush()) throw new Error("Resolve the canvas save before changing projects. Your edits are still here.");
      if (panel.current && !await panel.current.prepareToLeave()) { setProjectBusy(false); navigationBusy.current = false; return; }
      location.assign(`/projects/${encodeURIComponent(id)}/${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`);
    } catch (error) { notify(errorMessage(error)); setProjectBusy(false); navigationBusy.current = false; }
  };

  const registerProject = async (workspace: string) => {
    if (panel.current && !await panel.current.prepareToLeave()) return;
    const result = await hostApi<{ project: ProjectSummary; path: string }>("/api/projects", { workspace });
    if (result.project.id === projectBasePath.split("/").at(-1)) {
      setProjectPickerOpen(false);
      setProjectBusy(false);
      return;
    }
    location.assign(result.path);
  };

  const openProject = useCallback(async () => {
    if (desktopBusy.current || navigationBusy.current) return;
    if (!hasDesktopBridge()) { setProjectError(""); setProjectPath(""); setProjectPickerOpen(true); return; }
    desktopBusy.current = true;
    setProjectBusy(true);
    try {
      if (sendingRef.current.size) throw new Error("Wait for your message to finish submitting before adding a project.");
      if (!await canvas.flush()) throw new Error("Resolve the canvas save before adding a project. Your edits are still here.");
      const workspace = await desktopInvoke<string | null>('choose_workspace');
      if (workspace) await registerProject(workspace);
    } catch (error) { notify(errorMessage(error)); }
    finally { desktopBusy.current = false; setProjectBusy(false); }
  }, [canvas.flush, notify]);

  const submitProject = async () => {
    if (navigationBusy.current || !projectPath.trim()) return;
    navigationBusy.current = true;
    setProjectBusy(true);
    setProjectError("");
    try {
      if (sendingRef.current.size) throw new Error("Wait for your message to finish submitting before adding a project.");
      if (!await canvas.flush()) throw new Error("Resolve the canvas save before adding a project. Your edits are still here.");
      await registerProject(projectPath.trim());
    } catch (error) { setProjectError(errorMessage(error)); }
    finally { navigationBusy.current = false; setProjectBusy(false); }
  };

  const desktopAction = useCallback(async () => {
    if (desktopBusy.current || !hasDesktopBridge()) return;
    desktopBusy.current = true;
    try {
      if (sendingRef.current.size) throw new Error("Wait for your messages to finish submitting before closing this workspace.");
      if (!await canvas.flush()) throw new Error("Resolve the canvas save before closing this workspace. Your edits are still here.");
      if (panel.current && !await panel.current.prepareToLeave()) return;
      const snapshot = await hostApi<{ projects: Pick<ProjectSummary, "sessions">[] }>("/api/projects").catch(() => ({ projects: projects.length ? projects : [{ sessions: state?.sessions ?? [] }] }));
      const active = snapshot.projects.some(project => project.sessions.some(item => ['starting', 'running', 'awaiting_approval'].includes(item.status)));
      if (active && !window.confirm("Codex is still working. Stop all active turns in all projects and quit Canvagent?")) return;
      await desktopInvoke('quit_application');
    } catch (error) { notify(errorMessage(error)); }
    finally { desktopBusy.current = false; }
  }, [canvas.flush, notify, projects, state?.sessions]);

  useEffect(() => {
    if (!hasDesktopBridge()) return;
    const open = () => void openProject();
    const close = () => void desktopAction();
    window.addEventListener('canvagent:open-workspace', open);
    window.addEventListener('canvagent:close', close);
    return () => {
      window.removeEventListener('canvagent:open-workspace', open);
      window.removeEventListener('canvagent:close', close);
    };
  }, [desktopAction, openProject]);

  const notifications = useNotifications(async target => {
    window.dispatchEvent(new Event('canvagent:show-conversation'));
    if (target.projectId) await navigateProject(target.projectId, target.sessionId);
    else await activateSession(target.sessionId);
  });

  return <>
    <ChatWorkspace
      state={state} online={online} connecting={connecting} sending={sending} sessionBusy={sessionBusy || projectBusy}
      projects={projects} onActivateProject={navigateProject} notifications={notifications}
      notice={session ? notices[session.id]?.text ?? "" : ""} draftRequest={draftRequest} selectedIds={canvas.selectedIds}
      onClearSelection={() => canvas.selectElements([])} onSend={send} onNewSession={createSession}
      onActivateSession={activateSession} onConnect={() => void connectRuntime()} onInterrupt={interrupt}
      onChangeSettings={changeSettings} onSaveDefaultSettings={saveDefaultSettings} settingsSaving={settingsSaving}
      onError={notify} onDismissNotice={() => { if (session) setNotices(previous => ({ ...previous, [session.id]: { id: previous[session.id]?.id ?? "", text: "" } })); }}
      onOpenWorkspace={() => void openProject()}
      sessionContent={<>
        {session?.pendingApprovals.map(approval => <ApprovalCard key={approval.id} approval={approval} sessionId={session.id} onError={notify} />)}
        {session?.error && <div className="inline-error" role="alert"><Icon name="warning" size={16} /><span>{session.error}</span></div>}
        {session?.status === "unknown" && <div className="inline-error" role="alert"><Icon name="warning" size={16} /><span>The runtime disconnected. Reconnect, then send a message to resume this conversation.</span></div>}
        <ConversationFiles key={session?.id} artifacts={state?.artifacts.filter(artifact => artifact.sessionId === session?.id) ?? []} />
        {initialError && <div className="inline-error" role="alert"><Icon name="warning" size={16} /><span>{initialError}</span></div>}
      </>}
    >
      <RightPanel ref={panel} projectName={state?.project.name ?? "Project"} projectKey={projectBasePath} onError={notify}>
      <section className="canvas-pane" aria-label="Shared canvas">
        <div className="canvas-toolbar"><div className="canvas-title"><Icon name="board" size={16} /><strong>Shared canvas</strong><span className="shared-badge">YOU + CODEX</span></div><div className="canvas-toolbar-actions">{canvas.agentMutation && <button className="toolbar-button" title="Undo the last agent canvas edit safely" onClick={() => void canvas.undoAgent()}><Icon name="undo" size={15} /><span>Undo agent edit</span></button>}<button className="toolbar-button" title="Download an editable Excalidraw file" onClick={canvas.exportBoard} disabled={!currentBoard}><Icon name="download" size={15} /><span>Export</span></button><span className="toolbar-separator" /><button className="selection-action" disabled={!canvas.selectedIds.length} onClick={askSelection}><Icon name="select" size={14} /><span>Ask about selection</span></button></div></div>
        <CanvasWebsiteTools controller={websites} ready={!!currentBoard} />

        {canvas.saveStatus === "conflict" && <div className="conflict-banner"><Icon name="warning" size={17} /><div><strong>Some objects changed while you were drawing.</strong><span>Your local edits are still here. Choose which version to keep for the conflicting objects.</span></div><button onClick={() => canvas.resolveConflict(false)}>Use saved edits</button><button className="button-dark" onClick={() => canvas.resolveConflict(true)}>Keep my edits</button></div>}
        {canvas.saveStatus === "error" && <div className="save-error-banner"><Icon name="warning" size={15} /><span>Edits are kept in this window. {canvas.saveError}</span><button onClick={() => void canvas.flush()}>Retry save</button></div>}
        {!online && state && <div className="offline-banner"><span className="status-dot" />Reconnecting to your local service. Keep this window open to preserve unsaved edits.</div>}

        <div className="canvas-editor">
          {currentBoard ? <Excalidraw excalidrawAPI={bindCanvas} initialData={{ elements: structuredClone(currentBoard.elements) as any, files: structuredClone(currentBoard.files), appState: { viewBackgroundColor: currentBoard.elements.some(element => !element.isDeleted && element.type === 'embeddable') ? "transparent" : "#fcfcfa", currentItemStrokeColor: "#293a32", currentItemFontFamily: 5, gridSize: 20 } }} onChange={onCanvasChange} onPointerDown={canvas.onPointerDown} onPointerUp={canvas.onPointerUp} validateEmbeddable={validateCanvasWebsite} renderEmbeddable={websites.renderEmbeddable} theme="light" name="Canvagent shared canvas" UIOptions={{ canvasActions: { toggleTheme: false, changeViewBackgroundColor: websites.websites.length === 0 } }} /> : <div className="canvas-loading"><span className="working-spinner" /><span>{initialError ? "Waiting for the local service" : "Opening your canvas"}</span></div>}
          {currentBoard && visibleElementCount === 0 && <div className="canvas-empty" aria-hidden="true"><Icon name="board" size={29} /><h2>Your shared canvas</h2><p>Draw, paste an image, or sketch an idea.<br />Codex can see and edit what you put here.</p></div>}
          {canvas.selectedIds.length > 0 && <div className="floating-selection"><span>{canvas.selectedIds.length} selected</span><button onClick={askSelection}><Icon name="spark" size={13} />Ask Codex<Icon name="external" size={11} /></button></div>}
        </div>

        <footer className="canvas-footer"><div className={`save-state ${canvas.saveStatus}`}><span className={`status-dot ${canvas.saveStatus === "saving" ? "pulse" : ""}`} /><span>{canvas.saveStatus === "saved" ? "All changes saved" : canvas.saveStatus === "pending" ? "Unsaved changes" : canvas.saveStatus === "saving" ? "Saving changes…" : canvas.saveStatus === "conflict" ? "Choose which edits to keep" : "Changes need saving"}</span>{currentBoard && <span className="revision-label">rev {currentBoard.revision}</span>}</div><div className="canvas-legend"><span><i className="human-dot" />You</span><span><i className="agent-dot" />Codex</span><span className="legend-divider" /><span className="canvas-scope" title={canvas.agentMutation ? "Drawing undo history resets when shared edits arrive. Use Undo agent edit to safely revert Codex changes." : undefined}>{canvas.agentMutation ? "Agent edits have separate undo" : "One shared perspective"}</span></div></footer>
      </section>
      </RightPanel>
    </ChatWorkspace>
    <dialog ref={projectDialog} className="project-dialog" aria-labelledby="project-dialog-title" onCancel={event => { if (projectBusy) event.preventDefault(); else setProjectPickerOpen(false); }} onClose={() => setProjectPickerOpen(false)}>
      <form onSubmit={event => { event.preventDefault(); void submitProject(); }}>
        <div className="project-dialog-heading"><span className="workspace-icon"><Icon name="folder" size={20} /></span><h2 id="project-dialog-title">Add project</h2><button type="button" className="icon-button" aria-label="Close add project" disabled={projectBusy} onClick={() => setProjectPickerOpen(false)}><Icon name="close" size={17} /></button></div>
        <p>Open a folder on this computer. Its conversations and canvas will appear in your sidebar.</p>
        <label htmlFor="project-folder">Project folder</label>
        <input id="project-folder" placeholder="/path/to/your/project" value={projectPath} onChange={event => setProjectPath(event.target.value)} disabled={projectBusy} autoFocus autoComplete="off" required />
        {projectError && <p className="project-dialog-error" role="alert">{projectError}</p>}
        <div className="project-dialog-actions"><button type="button" disabled={projectBusy} onClick={() => setProjectPickerOpen(false)}>Cancel</button><button className="button-dark" disabled={projectBusy || !projectPath.trim()}>{projectBusy ? "Opening…" : "Add project"}</button></div>
      </form>
    </dialog>
    {toast && <div className="toast" role="status"><Icon name="info" size={16} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><Icon name="close" size={15} /></button></div>}
  </>;
}
