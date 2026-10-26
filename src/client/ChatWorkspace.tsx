import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { defaultAgentSettings, type AgentSettings } from "../shared/settings";
import type { ContextAttachment } from "../shared/context";
import { AgentSettingsControls } from "./AgentSettings";
import { AgentPicker, type SaveAgentInput } from "./AgentPicker";
import { errorMessage } from "./api";
import { BrandMark, Icon } from "./icons";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { usePaneLayout } from "./usePaneLayout";
import { Notifications } from './Notifications';
import { ContextAttachmentList, ContextComposer, useDraftAttachments, type DraftAttachments } from './ContextAttachments';
import type { NotificationsController } from './useNotifications';
import type { AppState, Message, ProjectSummary, Session } from "./types";

const AgentNameContext = createContext("Codex");
const MessageAttachmentsContext = createContext(new Map<string, ContextAttachment[]>());
const activeStatuses = new Set(["running", "starting", "awaiting_approval"]);
const titleFor = (session?: Pick<Session, "title">) => !session || session.title === "New session" ? "New conversation" : session.title;

function readDraft(id: string) {
  try { return sessionStorage.getItem(`canvagent:draft:${id}`) ?? ""; } catch { return ""; }
}
function writeDraft(id: string, text: string) {
  try {
    if (text) sessionStorage.setItem(`canvagent:draft:${id}`, text);
    else sessionStorage.removeItem(`canvagent:draft:${id}`);
  } catch { /* An unavailable browser storage must not prevent conversation. */ }
}

function RunStatus({ status }: { status?: Session["status"] }) {
  if (!status || !activeStatuses.has(status)) return null;
  const approval = status === "awaiting_approval";
  const label = approval ? "Needs approval" : "Working";
  return <span className={`thread-run-status ${approval ? "needs-approval" : ""}`} role="status" aria-label={label} title={label}><span className={approval ? "status-dot" : "working-spinner"} /></span>;
}

// The server remains the source of truth for messages and run state. This
// adapter only projects saved agent messages into assistant-ui's view model.
export function toChatMessage(message: Message): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role === "user" || message.role === "assistant" ? message.role : "system",
    content: [{ type: "text", text: message.text }],
    createdAt: new Date(message.createdAt),
  };
}

function Markdown() {
  return <MarkdownTextPrimitive className="message-content" smooth={false} components={{
    a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
  }} />;
}

function ChatMessage() {
  const agentName = useContext(AgentNameContext);
  const attachmentMap = useContext(MessageAttachmentsContext);
  const messageId = useAuiState(s => s.message.id);
  const attachments = attachmentMap.get(messageId) ?? [];
  const role = useAuiState(s => s.message.role);
  const empty = useAuiState(s => s.message.content.every(part => part.type === "text" && !part.text));
  const copied = useAuiState(s => s.message.isCopied);
  return <MessagePrimitive.Root className={`message message-${role}`}>
    {role === "assistant" && <div className="message-byline"><span className="agent-avatar"><Icon name="terminal" size={14} /></span><strong>{agentName}</strong></div>}
    {role === "system" && <span className="system-label"><Icon name="info" size={14} />System</span>}
    <div className="message-body">
      {empty ? role === "assistant" && !attachments.length ? <span className="thinking-dots" aria-label={`${agentName} is thinking`}><i /><i /><i /></span> : null : <MessagePrimitive.Parts components={{ Text: Markdown }} />}
      <ContextAttachmentList attachments={attachments} transcript />
    </div>
    {role === "assistant" && !empty && <ActionBarPrimitive.Root className="message-actions" hideWhenRunning>
      <ActionBarPrimitive.Copy className="icon-button" aria-label="Copy response" title={copied ? "Copied" : "Copy response"}><Icon name={copied ? "check" : "copy"} size={15} /></ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>}
  </MessagePrimitive.Root>;
}

function ConversationItem({ disabled, sessions }: { disabled: boolean; sessions: Session[] }) {
  const title = useAuiState(s => s.threadListItem.title ?? "New conversation");
  const id = useAuiState(s => s.threadListItem.id);
  const status = sessions.find(session => session.id === id)?.status;
  return <ThreadListItemPrimitive.Root className="thread-list-item">
    <ThreadListItemPrimitive.Trigger className="thread-list-trigger" aria-label={`Open conversation: ${title}`} disabled={disabled}>
      <Icon name="chat" size={15} /><ThreadListItemPrimitive.Title fallback="New conversation" />
      <RunStatus status={status} />
    </ThreadListItemPrimitive.Trigger>
  </ThreadListItemPrimitive.Root>;
}

type WorkspaceProps = {
  state?: AppState;
  online: boolean;
  connecting: boolean;
  sending: boolean;
  sessionBusy: boolean;
  notice: string;
  draftRequest?: { id: number; text: string };
  selectedIds: string[];
  onClearSelection: () => void;
  onSend: (text: string, attachments?: ContextAttachment[]) => Promise<void>;
  onNewSession: () => Promise<unknown>;
  onActivateSession: (id: string) => Promise<void>;
  onConnect: () => void;
  onSelectAgent: (agentId: string) => Promise<void>;
  onSaveAgent: (agent: SaveAgentInput) => Promise<void>;
  onRemoveAgent: (agentId: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
  settingsSaving?: boolean;
  onChangeSettings: (settings: Partial<AgentSettings>, remember?: boolean) => Promise<void>;
  onSaveDefaultSettings: (settings: AgentSettings) => Promise<void>;
  onError: (message: string) => void;
  onDismissNotice: () => void;
  onOpenWorkspace: () => void;
  projects: ProjectSummary[];
  notifications: NotificationsController;
  onActivateProject: (id: string, sessionId?: string) => Promise<void>;
  sessionContent: ReactNode;
  children: ReactNode;
};

function Composer({ props, running, ready, inputRef, context, setText }: {
  props: WorkspaceProps;
  running: boolean;
  ready: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  context: DraftAttachments;
  setText: (text: string) => void;
}) {
  const text = useAuiState(s => s.composer.text);
  const session = props.state?.sessions.find(item => item.id === props.state?.activeSessionId) ?? props.state?.sessions.at(-1);
  const agentId = session?.agentId ?? props.state?.defaultAgentId ?? "codex";
  const agent = props.state?.agents.find(item => item.id === agentId);
  const agentName = agent?.name ?? (agentId === "codex" ? "Codex" : "Agent");
  const settings = session?.settings ?? props.state?.runtime.settings ?? defaultAgentSettings();
  const steering = props.state?.runtime.capabilities?.steering ?? agent?.kind === "codex";
  const imageSupported = props.state?.runtime.capabilities?.imageInput !== false;
  const unsupportedImages = !imageSupported && context.attachments.some(item => item.kind === 'image');
  const sendLocked = useRef(new Set<string>());
  const canSend = (!!text.trim() || context.attachments.length > 0) && !props.sending && !props.sessionBusy && ready && props.online && !context.blocked && !unsupportedImages;
  const statusLabel = props.connecting ? `Connecting to ${agentName}…` : ready ? `${agentName} connected` : `${agentName} needs attention`;
  const connectionHint = props.connecting
    ? agent?.kind === "codex" ? `Connecting to ${agentName} with your existing login…` : `Connecting to ${agentName}…`
    : props.state?.runtime.error || (props.state?.runtime.connected && agent?.kind === "codex" ? "Sign in with codex login, then reconnect." : `Check ${agentName} configuration, then retry.`);
  // Harnesses without steering receive a queued message for their next turn.
  const sendUpdate = async () => {
    const scope = context.scope;
    if (!canSend || sendLocked.current.has(scope)) return;
    sendLocked.current.add(scope);
    try {
      await props.onSend(text, context.attachments);
    } catch (error) { props.onError(errorMessage(error)); }
    finally { sendLocked.current.delete(scope); }
  };
  return <div className="composer-area">
    {props.notice && <div className="context-notice" role="status"><Icon name="check" size={14} /><span>{props.notice}</span><button onClick={props.onDismissNotice} aria-label="Dismiss update notice"><Icon name="close" size={13} /></button></div>}
    {!ready && props.state && <div className="agent-connection-note"><Icon name="info" size={13} /><span>{connectionHint}</span>{!props.connecting && <button type="button" aria-label="Retry agent connection" disabled={!props.online || props.sessionBusy} onClick={props.onConnect}><Icon name="reconnect" size={12} />Retry</button>}</div>}
    <ComposerPrimitive.Root className="composer" onSubmit={event => { event.preventDefault(); void sendUpdate(); }}>
      <div className="composer-agent-bar">
        <AgentPicker agents={props.state?.agents ?? []} activeAgentId={agentId} disabled={running || props.sending || props.sessionBusy || !props.state || !props.online} hasMessages={!!session?.messages.length} onSelect={props.onSelectAgent} onSave={props.onSaveAgent} onRemove={props.onRemoveAgent} onError={props.onError} />
        <span className={`agent-connection-status ${ready ? "ready" : ""}`} role="status" aria-label={statusLabel}><span className={`status-dot ${props.connecting ? "pulse" : ""}`} /><span>{props.connecting ? "Connecting…" : ready ? "Ready" : "Needs attention"}</span></span>
      </div>
      {props.selectedIds.length > 0 && <div className="selection-chip"><Icon name="select" size={13} /><span>{props.selectedIds.length} {props.selectedIds.length === 1 ? "object" : "objects"} selected</span><button type="button" aria-label="Clear canvas selection" onClick={props.onClearSelection}><Icon name="close" size={12} /></button></div>}
      <ContextComposer controller={context} workspace={props.state?.project.workspace} sessionId={session?.id} text={text} setText={setText} inputRef={inputRef} imageSupported={imageSupported} disabled={!props.state || props.sessionBusy || !props.online}>
      {handlers => <ComposerPrimitive.Input
        {...handlers}
        ref={inputRef}
        aria-label={`Message ${agentName}`}
        placeholder={running ? steering ? `Send an update while ${agentName} works…` : `Queue another message for ${agentName}…` : `Message ${agentName}… · @ to add context`}
        className="composer-input"
        rows={2}
        maxRows={7}
        submitMode="none"
        addAttachmentOnPaste={false}
        autoFocus
        onKeyDown={event => {
          handlers.onKeyDown(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void sendUpdate();
          }
        }}
      />}
      </ContextComposer>
      <div className="composer-toolbar">
        {agent?.kind === "codex" ? <AgentSettingsControls key={session?.id ?? "new"} settings={settings} defaults={props.state?.runtime.defaults} models={props.state?.runtime.models ?? []} requirements={props.state?.runtime.requirements} running={running} disabled={!props.state || props.sessionBusy} saving={props.settingsSaving} onChange={props.onChangeSettings} onSaveDefaults={props.onSaveDefaultSettings} onError={props.onError} /> : <div className="composer-provider-settings">{agent?.kind === "acp" ? "Models and permissions follow your harness configuration." : agent?.model ? <span title="Model configured in Manage agents">{settings.model || agent.model}</span> : "Configure your provider in Manage agents."}</div>}
        <div className="composer-buttons">
          {running && <ComposerPrimitive.Cancel className="stop-button" aria-label="Stop agent" title="Stop the current turn"><Icon name="stop" size={13} />Stop</ComposerPrimitive.Cancel>}
          <button type="button" className="send-button" aria-label={running ? steering ? `Send update to ${agentName}` : `Queue message to ${agentName}` : `Send message to ${agentName}`} title={context.blocked ? 'Finish attaching context before sending' : running ? steering ? 'Send update (Enter)' : 'Queue for next turn (Enter)' : 'Send (Enter)'} disabled={!canSend} onClick={() => void sendUpdate()}><Icon name="arrow" size={18} /></button>
        </div>
      </div>
    </ComposerPrimitive.Root>
    <div className="composer-footer"><span className="canvas-context" title="The current canvas and your selection are included with each message"><Icon name="board" size={12} />Canvas included</span><span>{running && !steering ? "Enter to queue" : "Enter to send"} · Shift+Enter for newline</span></div>
  </div>;
}

export function ChatWorkspace(props: WorkspaceProps) {
  const { state } = props;
  const paneLayout = usePaneLayout(state?.project.workspace, props.onError);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | "canvas">("chat");
  const [activityOpen, setActivityOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("canvagent:collapsed-projects") ?? "[]")); } catch { return new Set(); }
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runtimeRef = useRef<AssistantRuntime>();
  const drafts = useRef(new Map<string, string>());
  const draftVersions = useRef(new Map<string, number>());
  const visibleSessionId = useRef<string>();
  const session = state?.sessions.find(item => item.id === state.activeSessionId) ?? state?.sessions.at(-1);
  const context = useDraftAttachments(state?.project.workspace, session?.id);
  const messageAttachments = useMemo(() => new Map((session?.messages ?? []).map(message => [message.id, message.attachments ?? []])), [session?.messages]);
  visibleSessionId.current = session?.id;
  const running = !!session && activeStatuses.has(session.status);
  const agentId = session?.agentId ?? state?.defaultAgentId ?? "codex";
  const agent = state?.agents.find(item => item.id === agentId);
  const agentName = agent?.name ?? (agentId === "codex" ? "Codex" : "Agent");
  const ready = !!state?.runtime.connected && !!state.runtime.authenticated && (!state.runtime.agentId || state.runtime.agentId === agentId);
  const threads = useMemo(() => [...(state?.sessions ?? [])].reverse().map(item => ({
    id: item.id, title: titleFor(item), status: "regular" as const,
  })), [state?.sessions]);
  const saveDraft = () => {
    if (session) {
      const text = runtimeRef.current?.thread.composer.getState().text ?? "";
      drafts.current.set(session.id, text);
      writeDraft(session.id, text);
    }
  };
  const sendMessage = async (text: string, attachments = context.attachments) => {
    const targetId = session?.id;
    const version = targetId ? draftVersions.current.get(targetId) : undefined;
    if (context.blocked) throw new Error('Finish attaching context before sending.');
    await props.onSend(text, attachments);
    context.accepted(attachments.map(item => item.id), context.scope);
    if (targetId && draftVersions.current.get(targetId) !== version) return;
    if (targetId && drafts.current.get(targetId) === text) { drafts.current.delete(targetId); writeDraft(targetId, ''); }
    const composer = runtimeRef.current?.thread.composer;
    if (visibleSessionId.current === targetId && composer?.getState().text === text) composer.setText("");
  };
  const runtime = useExternalStoreRuntime({
    messages: session?.messages ?? [],
    convertMessage: toChatMessage,
    isRunning: running,
    isDisabled: !state || props.sessionBusy,
    isSendDisabled: !ready || !props.online || props.sending,
    onNew: async message => {
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const targetId = session?.id;
      try { await sendMessage(text); }
      catch (error) {
        // assistant-ui clears a submitted draft; restore it when the server
        // rejects the send, without overwriting anything typed meanwhile.
        const composer = runtimeRef.current?.thread.composer;
        if (visibleSessionId.current === targetId && composer && !composer.getState().text.trim()) composer.setText(text);
        else if (targetId && !drafts.current.get(targetId)?.trim()) {
          drafts.current.set(targetId, text);
          writeDraft(targetId, text);
        }
        props.onError(errorMessage(error));
      }
    },
    onCancel: props.onInterrupt,
    adapters: { threadList: {
      threadId: session?.id,
      threads,
      isLoading: !state || props.sessionBusy,
      onSwitchToNewThread: async () => { saveDraft(); await props.onNewSession(); setSidebarOpen(false); },
      onSwitchToThread: async id => { saveDraft(); await props.onActivateSession(id); setSidebarOpen(false); },
    } },
  });
  runtimeRef.current = runtime;

  useEffect(() => {
    const restored = session ? drafts.current.get(session.id) ?? readDraft(session.id) : "";
    if (session) {
      drafts.current.set(session.id, restored);
      if (!draftVersions.current.has(session.id)) draftVersions.current.set(session.id, 0);
    }
    runtime.thread.composer.setText(restored);
    if (!session) return;
    const id = session.id;
    const persist = () => {
      const text = runtime.thread.composer.getState().text;
      if (drafts.current.get(id) !== text) draftVersions.current.set(id, (draftVersions.current.get(id) ?? 0) + 1);
      drafts.current.set(id, text);
      writeDraft(id, text);
    };
    return runtime.thread.composer.subscribe(persist);
  }, [session?.id, runtime]);

  useEffect(() => {
    if (!props.draftRequest) return;
    if (!runtime.thread.composer.getState().text.trim()) runtime.thread.composer.setText(props.draftRequest.text);
    setMobilePane("chat");
    inputRef.current?.focus();
  }, [props.draftRequest, runtime]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSidebarOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [sidebarOpen]);

  useEffect(() => {
    const show = () => { saveDraft(); setMobilePane("chat"); setSidebarOpen(false); };
    window.addEventListener('canvagent:show-conversation', show);
    return () => window.removeEventListener('canvagent:show-conversation', show);
  });

  const navigationBusy = !state || props.sessionBusy;
  const activities = session?.activities ?? [];
  const activeTool = [...activities].reverse().find(item => item.status === "running" || item.status === "in_progress");
  const suggest = (text: string) => { runtime.thread.composer.setText(text); inputRef.current?.focus(); };
  const activeProject = props.projects.find(project => project.workspace === state?.project.workspace);
  const sidebarProjects = props.projects.map(project => project.id === activeProject?.id && state ? { ...project, sessions: state.sessions } : project);
  const toggleProject = (id: string) => {
    setCollapsedProjects(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem("canvagent:collapsed-projects", JSON.stringify([...next])); } catch { /* Optional preference. */ }
      return next;
    });
  };
  const openProject = (id: string, sessionId?: string) => {
    saveDraft();
    void props.onActivateProject(id, sessionId);
    setSidebarOpen(false);
  };

  return <AgentNameContext.Provider value={agentName}><MessageAttachmentsContext.Provider value={messageAttachments}><AssistantRuntimeProvider runtime={runtime}>
    <div ref={paneLayout.shellRef} style={paneLayout.style} className={`app-shell ${sidebarOpen ? "sidebar-open" : ""} ${paneLayout.resizing ? "layout-resize-active" : ""}`}>
      {paneLayout.resizing && <div className="layout-resize-shield" aria-hidden="true" />}
      {sidebarOpen && <button className="sidebar-scrim" aria-label="Close conversation history" onClick={() => setSidebarOpen(false)} />}
      <aside id="workspace-sidebar" className="app-sidebar" aria-label="Conversation history">
        <div className="sidebar-brand"><a href="/" aria-label="Canvagent home"><span className="brand-icon"><BrandMark size={25} /></span>canvagent</a><button className="icon-button sidebar-close" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}><Icon name="close" size={17} /></button></div>
        <ThreadListPrimitive.Root className="thread-list">
          <ThreadListPrimitive.New className="new-conversation" disabled={navigationBusy} aria-label="New conversation"><Icon name="compose" size={17} />New conversation<span>＋</span></ThreadListPrimitive.New>
          <div className="sidebar-section-heading"><span className="sidebar-label">Projects</span><button className="icon-button" aria-label="Add project" title="Add project" disabled={navigationBusy} onClick={() => { saveDraft(); props.onOpenWorkspace(); }}><Icon name="plus" size={15} /></button></div>
          <div className="thread-list-items project-list">
            {sidebarProjects.map(project => {
              const active = project.id === activeProject?.id;
              const expanded = !collapsedProjects.has(project.id);
              return <section className="sidebar-project" key={project.id} aria-label={`Project: ${project.name}`}>
                <div className={`project-row ${active ? "active" : ""}`}>
                  <button className="project-disclosure" aria-label={`${expanded ? "Collapse" : "Expand"} project: ${project.name}`} aria-expanded={expanded} onClick={() => toggleProject(project.id)}><Icon name="chevron" size={13} className={expanded ? "" : "project-collapsed"} /></button>
                  <button className="project-trigger" aria-label={`Open project: ${project.name}`} aria-current={active ? "page" : undefined} title={project.available === false ? `${project.workspace} · Folder unavailable` : project.workspace} disabled={navigationBusy || project.available === false} onClick={() => openProject(project.id)}><Icon name="folder" size={16} /><span>{project.name}</span>{!expanded && <RunStatus status={project.sessions.some(item => item.status === "awaiting_approval") ? "awaiting_approval" : project.sessions.some(item => activeStatuses.has(item.status)) ? "running" : "idle"} />}{project.available === false && <Icon name="warning" size={13} />}</button>
                </div>
                {expanded && <div className="project-conversations">
                  {active ? <ThreadListPrimitive.Items>{() => <ConversationItem disabled={navigationBusy} sessions={state?.sessions ?? []} />}</ThreadListPrimitive.Items> : [...project.sessions].reverse().map(item => <div className="thread-list-item" key={item.id}><button className="thread-list-trigger" aria-label={`Open conversation: ${titleFor(item)}`} disabled={navigationBusy || project.available === false} onClick={() => openProject(project.id, item.id)}><Icon name="chat" size={14} /><span>{titleFor(item)}</span><RunStatus status={item.status} /></button></div>)}
                  {project.available === false && <span className="project-unavailable">Folder unavailable</span>}
                </div>}
              </section>;
            })}
            {!sidebarProjects.length && <ThreadListPrimitive.Items>{() => <ConversationItem disabled={navigationBusy} sessions={state?.sessions ?? []} />}</ThreadListPrimitive.Items>}
          </div>
        </ThreadListPrimitive.Root>
        <div className="sidebar-workspace" title={state?.project.workspace}><span className="workspace-icon"><Icon name="folder" size={17} /></span><div><strong>{state?.project.name ?? "Local workspace"}</strong><span>Local workspace</span></div><span className={`status-dot ${props.online ? "online" : ""}`} /></div>
      </aside>
      <PaneResizeHandle className="sidebar-resize-handle" label="Resize sidebar" controls="workspace-sidebar" {...paneLayout.sidebar} onCommit={paneLayout.commit} onDraggingChange={paneLayout.dragging} />

      <div className={`main-workspace mobile-${mobilePane}`}>
        <header className="app-header">
          <div className="header-title"><button className="icon-button sidebar-toggle" aria-label="Open conversation history" onClick={() => setSidebarOpen(true)}><Icon name="sidebar" size={19} /></button><span className="header-project">{state?.project.name ?? "canvagent"}</span><span className="header-slash">/</span><span className="header-conversation">{titleFor(session)}</span></div>
          <div className="header-actions"><Notifications controller={props.notifications} disabled={navigationBusy} onOpen={async item => { saveDraft(); setMobilePane("chat"); await props.notifications.open(item); }} /></div>
        </header>
        <nav className="mobile-tabs" aria-label="Workspace view"><button className={mobilePane === "chat" ? "active" : ""} onClick={() => setMobilePane("chat")}><Icon name="chat" size={16} />Conversation</button><button className={mobilePane === "canvas" ? "active" : ""} onClick={() => setMobilePane("canvas")}><Icon name="board" size={16} />Workspace</button></nav>
        <main ref={paneLayout.splitRef} className="workspace-layout">
          <section id="workspace-conversation" className="conversation-pane" aria-label="Agent conversation">
            <ThreadPrimitive.Root className="chat-thread">
              <ThreadPrimitive.Viewport className="transcript">
                {!session?.messages.length && !running && <div className="welcome">
                  <div className="welcome-symbol"><Icon name="terminal" size={25} /></div>
                  <h1>What are we working on?</h1>
                  <p>Bring an idea, a question, or a sketch.<br />{agentName} can work with you on the canvas.</p>
                  <div className="suggestions"><button onClick={() => suggest("Help me plan what to build in this workspace.")}><Icon name="spark" size={17} /><span>Plan something new<small>Turn an idea into a starting point</small></span><Icon name="arrow-right" size={15} /></button><button onClick={() => suggest("Read and inspect the shared canvas, then help me improve it.")}><Icon name="board" size={17} /><span>Explore the canvas<small>Think through what's on the board</small></span><Icon name="arrow-right" size={15} /></button></div>
                </div>}
                <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
                {running && <div className="working-line" role="status"><span className="working-spinner" /><span>{session?.status === "awaiting_approval" ? "Waiting for your approval" : activeTool?.title || `${agentName} is working`}</span></div>}
                {!!activities.length && <div className="activity-block"><button className="activity-toggle" aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}><Icon name="terminal" size={14} /><span>Tool activity</span><span className="activity-count">{activities.length}</span><Icon name="chevron" size={14} className={activityOpen ? "rotate" : ""} /></button>{activityOpen && <div className="activity-list">{activities.map(activity => <details className="activity-item" key={activity.id}><summary><span className={`activity-dot ${activity.status ?? ""}`} /><span>{activity.title}</span><span className="activity-state">{activity.status?.replaceAll("_", " ")}</span></summary>{activity.detail && <pre>{activity.detail}</pre>}</details>)}</div>}</div>}
                {props.sessionContent}
                <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom" aria-label="Scroll to latest message"><Icon name="down" size={17} /></ThreadPrimitive.ScrollToBottom>
              </ThreadPrimitive.Viewport>
              <Composer props={{ ...props, onSend: sendMessage }} running={running} ready={ready} inputRef={inputRef} context={context} setText={text => runtime.thread.composer.setText(text)} />
            </ThreadPrimitive.Root>
          </section>
          <PaneResizeHandle className="workspace-resize-handle" label="Resize chat and workspace" controls="workspace-conversation" {...paneLayout.chat} onCommit={paneLayout.commit} onDraggingChange={paneLayout.dragging} />
          {props.children}
        </main>
      </div>
    </div>
  </AssistantRuntimeProvider></MessageAttachmentsContext.Provider></AgentNameContext.Provider>;
}
