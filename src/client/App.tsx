import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import ReactMarkdown from "react-markdown";
import { api, errorMessage } from "./api";
import { BrandMark, Icon } from "./icons";
import { useBoard } from "./useBoard";
import type { AppState, Approval, Runtime, Session } from "./types";

const activeStatuses = new Set(["running", "starting", "awaiting_approval"]);

function timeLabel(date: string) {
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? "" : value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function ApprovalCard({ approval, sessionId, onError }: { approval: Approval; sessionId: string; onError: (message: string) => void }) {
  const [deciding, setDeciding] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const command = approval.command || approval.item?.command || approval.params?.command;
  const questions: any[] = approval.params?.questions || [];
  const choices: string[] = approval.choices || ["accept", "decline"];
  const labels: Record<string, string> = { accept: "Approve once", acceptForSession: "Approve for session", decline: "Deny", cancel: "Stop turn", answer: "Send answers" };
  const decide = async (decision: string) => {
    setDeciding(true);
    try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approval.id)}`, { decision, requestId: crypto.randomUUID(), ...(decision === "answer" ? { answers: Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id]?.trim() || ""] }])) } : {}) }); }
    catch (error) { onError(errorMessage(error)); setDeciding(false); }
  };
  return <div className="approval-card">
    <div className="approval-heading"><Icon name="warning" size={16} /><strong>{approval.title || "Your approval is needed"}</strong></div>
    <p>{approval.description || approval.reason || "Codex is requesting permission to continue this operation."}</p>
    {command && <pre>{Array.isArray(command) ? command.join(" ") : command}</pre>}
    {approval.params?.permissions && <pre>{JSON.stringify(approval.params.permissions, null, 2)}</pre>}
    {(approval.cwd || approval.params?.cwd) && <span className="approval-cwd">{approval.cwd || approval.params.cwd}</span>}
    {questions.map(question => <fieldset className="agent-question" key={question.id}><legend>{question.question || question.header || "Your answer"}</legend>{question.options?.map((option: any) => <label key={option.label}><input type="radio" name={`${approval.id}-${question.id}`} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}<input className="question-custom-answer" aria-label={`Answer: ${question.question || question.id}`} placeholder={question.options?.length ? "Or write an answer…" : "Your answer…"} type={question.isSecret ? "password" : "text"} value={question.options?.some((option: any) => option.label === answers[question.id]) ? "" : answers[question.id] || ""} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} /></fieldset>)}
    <div className="approval-actions">{choices.map(choice => <button key={choice} className={choice === "accept" || choice === "answer" ? "button-dark" : ""} onClick={() => void decide(choice)} disabled={deciding || (choice === "answer" && (!questions.length || questions.some(question => !answers[question.id]?.trim())))}>{deciding ? "Sending…" : labels[choice] || choice}</button>)}</div>
  </div>;
}

export default function App() {
  const [state, setState] = useState<AppState>();
  const [online, setOnline] = useState(false);
  const [initialError, setInitialError] = useState("");
  const [toast, setToast] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | "canvas">("chat");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastNotice = useRef("");
  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6500);
  }, []);
  const canvas = useBoard(notify);
  const boardReceiver = useRef(canvas.receiveBoard);
  boardReceiver.current = canvas.receiveBoard;
  const captureHandler = useRef(canvas.capture);
  captureHandler.current = canvas.capture;

  const applyState = useCallback((incoming: AppState) => {
    setState(incoming);
    boardReceiver.current(incoming.board);
    setInitialError("");
  }, []);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const boot = async () => {
      try { const incoming = await api<AppState>("/api/state"); if (!disposed) applyState(incoming); }
      catch (error) { if (!disposed) setInitialError(errorMessage(error)); }
      if (!disposed) connect();
    };
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`);
      socket.onopen = () => { attempts = 0; setOnline(true); };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "state") applyState(message.state);
          else if (message.type === "board") boardReceiver.current(message.board, message.mutation);
          else if (message.type === "runtime") setState(previous => previous ? { ...previous, runtime: message.runtime } : previous);
          else if (message.type === "session") { const activity = [...(message.session.activities || [])].reverse().find((entry: any) => entry.kind === "canvas" && entry.title?.startsWith("Canvas revision")); if (activity && lastNotice.current !== activity.id) { lastNotice.current = activity.id; setNotice(activity.title); } setState(previous => {
            if (!previous) return previous;
            const exists = previous.sessions.some(session => session.id === message.session.id);
            return { ...previous, sessions: exists ? previous.sessions.map(session => session.id === message.session.id ? message.session : session) : [...previous.sessions, message.session], activeSessionId: message.activeSessionId ?? previous.activeSessionId };
          }); }
          else if (message.type === "capture") void captureHandler.current(message);
          else if (message.type === "notice" || message.type === "canvas_notice") setNotice(message.message || message.text || "Canvas changes shared with the agent.");
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
  }, [applyState]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (canvas.saveStatus !== "saved") { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [canvas.saveStatus]);

  const sessions = state?.sessions || [];
  const session = sessions.find(candidate => candidate.id === state?.activeSessionId) || sessions.at(-1);
  const runtime = state?.runtime;
  const running = !!session && activeStatuses.has(session.status);
  const ready = !!runtime?.connected && !!runtime?.authenticated;
  const messages = session?.messages || [];
  const activities = session?.activities || [];
  const activeTool = [...activities].reverse().find(activity => activity.status === "running" || activity.status === "in_progress");
  const currentBoard = canvas.board || state?.board;
  const visibleElementCount = canvas.elementCount;

  useEffect(() => {
    if (stickToBottom.current && transcript.current) transcript.current.scrollTo({ top: transcript.current.scrollHeight, behavior: running ? "instant" : "smooth" });
  }, [messages, activities, running, session?.pendingApprovals]);

  useEffect(() => { stickToBottom.current = true; setNotice(""); }, [session?.id]);

  useEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = "auto";
    composer.current.style.height = `${Math.min(180, composer.current.scrollHeight)}px`;
  }, [text]);

  const refresh = async () => { const incoming = await api<AppState>("/api/state"); applyState(incoming); return incoming; };

  const createSession = async () => {
    setSessionBusy(true);
    try {
      if (!await canvas.flush()) throw new Error("Save or resolve your canvas edits before starting another conversation.");
      const result = await api<any>("/api/sessions", {});
      const incoming = await refresh();
      setText("");
      composer.current?.focus();
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
      setText("");
      document.querySelector<HTMLDetailsElement>(".session-history")?.removeAttribute("open");
    } catch (error) { notify(errorMessage(error)); }
    finally { setSessionBusy(false); }
  };

  const send = async () => {
    if (!text.trim() || sending || !online) return;
    setSending(true);
    try {
      if (!await canvas.flush()) throw new Error("Your message is ready. Resolve the canvas save first so the agent receives the right version.");
      let target = session;
      if (!target) target = await createSession();
      if (!target) return;
      await api(`/api/sessions/${encodeURIComponent(target.id)}/messages`, { text: text.trim(), requestId: crypto.randomUUID(), selection: { elementIds: canvas.selectedIds } });
      setText("");
      stickToBottom.current = true;
    } catch (error) { notify(errorMessage(error)); }
    finally { setSending(false); composer.current?.focus(); }
  };

  const connectRuntime = async () => {
    setConnecting(true);
    try { await api("/api/runtime/connect", {}); await refresh(); }
    catch (error) { notify(errorMessage(error)); }
    finally { setConnecting(false); }
  };

  const interrupt = async () => {
    if (!session) return;
    try { await api(`/api/sessions/${encodeURIComponent(session.id)}/interrupt`, {}); }
    catch (error) { notify(errorMessage(error)); }
  };

  const changeModel = async (model: string) => {
    try { await api("/api/settings", { model }); await refresh(); }
    catch (error) { notify(errorMessage(error)); }
  };

  const askSelection = () => {
    setText(previous => previous || "Help me work on the selected part of the canvas.");
    setMobilePane("chat");
    composer.current?.focus();
  };

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="/" aria-label="Canvagent home"><BrandMark /><span>canvagent<span className="brand-dot">.</span></span></a>
      <div className="header-divider" />
      <div className="workspace" title={state?.project.workspace || "Local workspace"}><span className="workspace-icon"><Icon name="folder" size={17} /></span><div><span className="eyebrow">WORKSPACE</span><strong>{state?.project.name || "Your workspace"}</strong></div><span className="local-label">LOCAL</span></div>
      <div className="header-right">
        <span className="privacy-label"><span className="tiny-lock">⌑</span> On your machine</span>
        <button className={`runtime-status ${ready ? "ready" : "not-ready"}`} onClick={() => !ready && void connectRuntime()} disabled={connecting} title={runtime?.error || `Codex ${runtime?.version || "runtime"}`}><span className={`status-dot ${connecting ? "pulse" : ""}`} />{connecting ? "Connecting…" : ready ? "Codex connected" : "Connect Codex"}{!ready && <Icon name="reconnect" size={13} />}</button>
      </div>
    </header>

    <nav className="mobile-tabs" aria-label="Workspace view"><button className={mobilePane === "chat" ? "active" : ""} onClick={() => setMobilePane("chat")}><Icon name="chat" size={16} />Conversation</button><button className={mobilePane === "canvas" ? "active" : ""} onClick={() => setMobilePane("canvas")}><Icon name="board" size={16} />Canvas</button></nav>

    <main className={`workspace-layout mobile-${mobilePane}`}>
      <aside className="conversation-pane" aria-label="Agent conversation">
        <div className="conversation-header"><div className="pane-heading"><Icon name="chat" size={16} /><span>Conversation</span><span className="pane-number">01</span></div><div className="conversation-actions">
          <details className="session-history"><summary className="icon-button" aria-label="Conversation history" title="Conversation history"><Icon name="history" size={17} /></summary><div className="history-menu"><span className="menu-label">CONVERSATIONS</span>{sessions.length ? [...sessions].reverse().map(item => <button key={item.id} onClick={() => void activateSession(item.id)} disabled={sessionBusy || running}><Icon name="chat" size={14} /><span>{item.title || "Untitled conversation"}</span>{item.id === session?.id && <Icon name="check" size={14} />}</button>) : <p>Your conversations will appear here.</p>}</div></details>
          <button className="icon-button" title="New conversation" aria-label="New conversation" onClick={() => void createSession()} disabled={sessionBusy || running}><Icon name="plus" size={19} /></button>
        </div></div>

        <div className="session-line"><span className={`small-dot ${running ? "working" : ""}`} /><span>{session?.title || "A fresh conversation"}</span>{running && <span className="live-badge">LIVE</span>}</div>

        <div className="transcript" ref={transcript} onScroll={() => { if (transcript.current) stickToBottom.current = transcript.current.scrollHeight - transcript.current.scrollTop - transcript.current.clientHeight < 100; }}>
          {!messages.length && <div className="welcome">
            <div className="welcome-symbol"><Icon name="spark" size={26} /><span className="welcome-orbit" /></div>
            <span className="eyebrow">YOUR SHARED WORKSPACE</span>
            <h1>Think it through.<br />Build it together.</h1>
            <p>A conversation for the details.<br />A canvas for everything in between.</p>
            <div className="welcome-rule" />
            <div className="welcome-steps"><div><span>1</span><p>Sketch an idea or drop in an image.</p></div><div><span>2</span><p>Ask Codex to help you move it forward.</p></div><div><span>3</span><p>Keep the conversation and canvas in sync.</p></div></div>
            <button className="starter-prompt" onClick={() => { setText("Help me plan what to build in this workspace."); composer.current?.focus(); }}><Icon name="terminal" size={16} /><span>Start with a plan</span><span className="prompt-arrow">↗</span></button>
          </div>}

          {messages.map((message, index) => <article className={`message message-${message.role}`} key={message.id}>
            <div className="message-byline"><span className={`message-avatar ${message.role === "assistant" ? "agent-avatar" : ""}`}>{message.role === "assistant" ? <Icon name="spark" size={13} /> : message.role === "user" ? "Y" : <Icon name="terminal" size={13} />}</span><strong>{message.role === "assistant" ? "Codex" : message.role === "user" ? "You" : "System"}</strong><time>{timeLabel(message.createdAt)}</time>{message.role === "assistant" && running && index === messages.length - 1 && <span className="streaming-indicator" />}</div>
            <div className="message-content"><ReactMarkdown components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{message.text || (running && message.role === "assistant" ? "Thinking…" : "")}</ReactMarkdown></div>
          </article>)}

          {running && <div className="working-line"><span className="working-spinner" /><span>{session?.status === "awaiting_approval" ? "Waiting for your approval" : activeTool?.title || "Codex is working"}</span></div>}

          {!!activities.length && <div className="activity-block"><button className="activity-toggle" onClick={() => setActivityOpen(!activityOpen)}><Icon name="terminal" size={14} /><span>Tool activity</span><span className="activity-count">{activities.length}</span><Icon name="chevron" size={14} className={activityOpen ? "rotate" : ""} /></button>{activityOpen && <div className="activity-list">{activities.map(activity => <details className="activity-item" key={activity.id}><summary><span className={`activity-dot ${activity.status || ""}`} /><span>{activity.title}</span><span className="activity-state">{activity.status?.replaceAll("_", " ")}</span></summary>{activity.detail && <pre>{activity.detail}</pre>}</details>)}</div>}</div>}

          {session?.pendingApprovals?.map(approval => <ApprovalCard key={approval.id} approval={approval} sessionId={session.id} onError={notify} />)}
          {session?.error && <div className="inline-error"><Icon name="warning" size={16} /><span>{session.error}</span></div>}
          {session?.status === "unknown" && <div className="inline-error"><Icon name="warning" size={16} /><span>The runtime disconnected during this turn. Reconnect, then send a message to resume the saved conversation.</span></div>}
          {state?.artifacts?.some(artifact => artifact.sessionId === session?.id) && <div className="session-artifacts"><span className="menu-label">FILES FROM THIS CONVERSATION</span>{state.artifacts.filter(artifact => artifact.sessionId === session?.id).map(artifact => <a key={artifact.id} href={`/api/artifacts/${encodeURIComponent(artifact.id)}`} download={artifact.fileName}><Icon name={artifact.mimeType?.startsWith("image/") ? "image" : "download"} size={15} /><span>{artifact.title || artifact.fileName}<small>{artifact.fileName}</small></span><Icon name="download" size={13} /></a>)}</div>}
          {initialError && <div className="inline-error"><Icon name="warning" size={16} /><span>{initialError}</span></div>}
        </div>

        <div className="composer-area">
          {!ready && runtime && <div className="connection-note"><Icon name="terminal" size={15} /><div><strong>{runtime.connected && !runtime.authenticated ? "Sign in to Codex to begin" : "Your runtime is not connected"}</strong><span>{runtime.error || (runtime.connected ? "Run codex login on this machine, then reconnect." : "Connect your local Codex runtime above.")}</span></div></div>}
          {notice && <div className="context-notice"><Icon name="check" size={13} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss update notice"><Icon name="close" size={12} /></button></div>}
          <div className={`composer ${sending ? "sending" : ""}`}>
            {canvas.selectedIds.length > 0 && <div className="selection-chip"><Icon name="select" size={13} /><span>{canvas.selectedIds.length} {canvas.selectedIds.length === 1 ? "object" : "objects"} selected</span><button aria-label="Clear canvas selection" onClick={() => canvas.selectElements([])}><Icon name="close" size={12} /></button></div>}
            <textarea ref={composer} value={text} onChange={event => setText(event.target.value)} placeholder={running ? "Send an update while Codex works…" : "Ask, build, or point to something…"} aria-label="Message Codex" rows={2} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
            <div className="composer-toolbar"><span className="canvas-context"><Icon name="board" size={13} /><span>Canvas included</span><span className="context-dot" /></span><div className="composer-buttons">{running && <button className="stop-button" onClick={() => void interrupt()} aria-label="Stop agent" title="Interrupt the current turn"><Icon name="stop" size={11} />Stop</button>}<button className="send-button" aria-label={running ? "Send update to Codex" : "Send message to Codex"} title={running ? "Send update (Ctrl / ⌘ + Enter)" : "Send (Ctrl / ⌘ + Enter)"} disabled={!text.trim() || sending || !online || !ready} onClick={() => void send()}>{sending ? <span className="button-spinner" /> : <Icon name="arrow" size={17} />}</button></div></div>
          </div>
          <div className="composer-footer"><label className="model-select"><Icon name="spark" size={11} /><select aria-label="Agent model" value={runtime?.model || runtime?.models?.[0]?.id || ""} onChange={event => void changeModel(event.target.value)} disabled={running || !runtime?.models?.length}>{runtime?.models?.length ? runtime.models.map(model => <option value={model.id} key={model.id}>{model.name || model.id}</option>) : <option value="">Codex · default model</option>}</select><Icon name="chevron" size={10} /></label><span>⌘ / Ctrl ↵ to send</span></div>
        </div>
      </aside>

      <section className="canvas-pane" aria-label="Shared canvas">
        <div className="canvas-toolbar"><div className="canvas-title"><Icon name="board" size={16} /><strong>Shared canvas</strong><span className="shared-badge">YOU + CODEX</span></div><div className="canvas-toolbar-actions">{canvas.agentMutation && <button className="toolbar-button" title="Undo the last agent canvas edit safely" onClick={() => void canvas.undoAgent()}><Icon name="undo" size={15} /><span>Undo agent edit</span></button>}<button className="toolbar-button" title="Download an editable Excalidraw file" onClick={canvas.exportBoard} disabled={!currentBoard}><Icon name="download" size={15} /><span>Export</span></button><span className="toolbar-separator" /><button className="selection-action" disabled={!canvas.selectedIds.length} onClick={askSelection}><Icon name="select" size={14} /><span>Ask about selection</span></button></div></div>

        {canvas.saveStatus === "conflict" && <div className="conflict-banner"><Icon name="warning" size={17} /><div><strong>Some objects changed while you were drawing.</strong><span>Your local edits are still here. Choose which version to keep for the conflicting objects.</span></div><button onClick={() => canvas.resolveConflict(false)}>Use saved edits</button><button className="button-dark" onClick={() => canvas.resolveConflict(true)}>Keep my edits</button></div>}
        {canvas.saveStatus === "error" && <div className="save-error-banner"><Icon name="warning" size={15} /><span>Edits are kept in this window. {canvas.saveError}</span><button onClick={() => void canvas.flush()}>Retry save</button></div>}
        {!online && state && <div className="offline-banner"><span className="status-dot" />Reconnecting to your local service. Keep this window open to preserve unsaved edits.</div>}

        <div className="canvas-editor">
          {currentBoard ? <Excalidraw excalidrawAPI={canvas.bindEditor} initialData={{ elements: currentBoard.elements as any, files: currentBoard.files, appState: { viewBackgroundColor: "#fcfcfa", currentItemStrokeColor: "#293a32", currentItemFontFamily: 5, gridSize: 20 } }} onChange={canvas.onChange} theme="light" name="Canvagent shared canvas" UIOptions={{ canvasActions: { toggleTheme: false } }} /> : <div className="canvas-loading"><span className="working-spinner" /><span>{initialError ? "Waiting for the local service" : "Opening your canvas"}</span></div>}
          {currentBoard && visibleElementCount === 0 && <div className="canvas-empty" aria-hidden="true"><div className="empty-sketch"><div className="sketch-node node-one">An idea</div><span className="sketch-connector">↗</span><div className="sketch-node node-two"><Icon name="spark" size={20} /><span>A little clarity</span></div><div className="sketch-note">room to think</div></div><h2>Make room for your ideas.</h2><p>Draw a thought, paste a screenshot, or map something out.<br />You and your agent share this space.</p><span className="canvas-empty-hint">Pick a tool above to get started</span></div>}
          {canvas.selectedIds.length > 0 && <div className="floating-selection"><span>{canvas.selectedIds.length} selected</span><button onClick={askSelection}><Icon name="spark" size={13} />Ask Codex<Icon name="external" size={11} /></button></div>}
        </div>

        <footer className="canvas-footer"><div className={`save-state ${canvas.saveStatus}`}><span className={`status-dot ${canvas.saveStatus === "saving" ? "pulse" : ""}`} /><span>{canvas.saveStatus === "saved" ? "All changes saved" : canvas.saveStatus === "pending" ? "Unsaved changes" : canvas.saveStatus === "saving" ? "Saving changes…" : canvas.saveStatus === "conflict" ? "Choose which edits to keep" : "Changes need saving"}</span>{currentBoard && <span className="revision-label">rev {currentBoard.revision}</span>}</div><div className="canvas-legend"><span><i className="human-dot" />You</span><span><i className="agent-dot" />Codex</span><span className="legend-divider" /><span className="canvas-scope">One shared perspective</span></div></footer>
      </section>
    </main>

    {toast && <div className="toast" role="status"><Icon name="chat" size={16} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><Icon name="close" size={15} /></button></div>}
  </div>;
}
