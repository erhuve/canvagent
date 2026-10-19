import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { errorMessage } from "./api";
import { Icon } from "./icons";
import type { AppState, Message, Session } from "./types";

const activeStatuses = new Set(["running", "starting", "awaiting_approval"]);
const titleFor = (session?: Session) => !session || session.title === "New session" ? "New conversation" : session.title;

// The server remains the source of truth for messages and run state. This
// adapter only projects saved Codex messages into assistant-ui's view model.
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
  const role = useAuiState(s => s.message.role);
  const empty = useAuiState(s => s.message.content.every(part => part.type === "text" && !part.text));
  const copied = useAuiState(s => s.message.isCopied);
  return <MessagePrimitive.Root className={`message message-${role}`}>
    {role === "assistant" && <div className="message-byline"><span className="agent-avatar"><Icon name="terminal" size={14} /></span><strong>Codex</strong></div>}
    {role === "system" && <span className="system-label"><Icon name="info" size={14} />System</span>}
    <div className="message-body">
      {empty ? <span className="thinking-dots" aria-label="Codex is thinking"><i /><i /><i /></span> : <MessagePrimitive.Parts components={{ Text: Markdown }} />}
    </div>
    {role === "assistant" && !empty && <ActionBarPrimitive.Root className="message-actions" hideWhenRunning>
      <ActionBarPrimitive.Copy className="icon-button" aria-label="Copy response" title={copied ? "Copied" : "Copy response"}><Icon name={copied ? "check" : "copy"} size={15} /></ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>}
  </MessagePrimitive.Root>;
}

function ConversationItem({ disabled }: { disabled: boolean }) {
  const title = useAuiState(s => s.threadListItem.title ?? "New conversation");
  return <ThreadListItemPrimitive.Root className="thread-list-item">
    <ThreadListItemPrimitive.Trigger className="thread-list-trigger" aria-label={`Open conversation: ${title}`} disabled={disabled}>
      <Icon name="chat" size={15} /><ThreadListItemPrimitive.Title fallback="New conversation" />
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
  onSend: (text: string) => Promise<void>;
  onNewSession: () => Promise<unknown>;
  onActivateSession: (id: string) => Promise<void>;
  onConnect: () => void;
  onInterrupt: () => Promise<void>;
  onChangeModel: (model: string) => void;
  onError: (message: string) => void;
  onDismissNotice: () => void;
  onOpenWorkspace: () => void;
  sessionContent: ReactNode;
  children: ReactNode;
};

function Composer({ runtime, props, running, ready, inputRef }: {
  runtime: AssistantRuntime;
  props: WorkspaceProps;
  running: boolean;
  ready: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement>;
}) {
  const text = useAuiState(s => s.composer.text);
  // A running Codex turn accepts immediate steering through the existing API.
  // Keep that behavior instead of introducing a second, client-owned queue.
  const sendUpdate = async () => {
    if (!text.trim() || props.sending || props.sessionBusy || !ready || !props.online) return;
    try {
      await props.onSend(text);
      if (runtime.thread.composer.getState().text === text) runtime.thread.composer.setText("");
    } catch (error) { props.onError(errorMessage(error)); }
  };
  return <div className="composer-area">
    {props.notice && <div className="context-notice" role="status"><Icon name="check" size={14} /><span>{props.notice}</span><button onClick={props.onDismissNotice} aria-label="Dismiss update notice"><Icon name="close" size={13} /></button></div>}
    <ComposerPrimitive.Root className="composer">
      {props.selectedIds.length > 0 && <div className="selection-chip"><Icon name="select" size={13} /><span>{props.selectedIds.length} {props.selectedIds.length === 1 ? "object" : "objects"} selected</span><button type="button" aria-label="Clear canvas selection" onClick={props.onClearSelection}><Icon name="close" size={12} /></button></div>}
      <ComposerPrimitive.Input
        ref={inputRef}
        aria-label="Message Codex"
        placeholder={running ? "Send an update while Codex works…" : "Message Codex…"}
        className="composer-input"
        rows={2}
        maxRows={7}
        submitMode="ctrlEnter"
        autoFocus
        onKeyDown={event => {
          if (running && event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void sendUpdate();
          }
        }}
      />
      <div className="composer-toolbar">
        <span className="canvas-context" title="The current canvas and your selection are included with each message"><Icon name="board" size={14} />Canvas included</span>
        <div className="composer-buttons">
          {running && <ComposerPrimitive.Cancel className="stop-button" aria-label="Stop agent" title="Stop the current turn"><Icon name="stop" size={13} />Stop</ComposerPrimitive.Cancel>}
          {running
            ? <button type="button" className="send-button" aria-label="Send update to Codex" title="Send update (⌘ / Ctrl + Enter)" disabled={!text.trim() || props.sending || props.sessionBusy || !props.online || !ready} onClick={() => void sendUpdate()}><Icon name="arrow" size={18} /></button>
            : <ComposerPrimitive.Send className="send-button" aria-label="Send message to Codex" title="Send (⌘ / Ctrl + Enter)"><Icon name="arrow" size={18} /></ComposerPrimitive.Send>}
        </div>
      </div>
    </ComposerPrimitive.Root>
    <div className="composer-footer"><span>Codex works in your local workspace.</span><span>⌘ / Ctrl ↵</span></div>
  </div>;
}

export function ChatWorkspace(props: WorkspaceProps) {
  const { state } = props;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | "canvas">("chat");
  const [activityOpen, setActivityOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runtimeRef = useRef<AssistantRuntime>();
  const session = state?.sessions.find(item => item.id === state.activeSessionId) ?? state?.sessions.at(-1);
  const running = !!session && activeStatuses.has(session.status);
  const ready = !!state?.runtime.connected && !!state.runtime.authenticated;
  const threads = useMemo(() => [...(state?.sessions ?? [])].reverse().map(item => ({
    id: item.id, title: titleFor(item), status: "regular" as const,
  })), [state?.sessions]);
  const runtime = useExternalStoreRuntime({
    messages: session?.messages ?? [],
    convertMessage: toChatMessage,
    isRunning: running,
    isDisabled: !state || props.sessionBusy,
    isSendDisabled: !ready || !props.online || props.sending,
    onNew: async message => {
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      try { await props.onSend(text); }
      catch (error) {
        // assistant-ui clears a submitted draft; restore it when the server
        // rejects the send, without overwriting anything typed meanwhile.
        const composer = runtimeRef.current?.thread.composer;
        if (composer && !composer.getState().text.trim()) composer.setText(text);
        props.onError(errorMessage(error));
      }
    },
    onCancel: props.onInterrupt,
    adapters: { threadList: {
      threadId: session?.id,
      threads,
      isLoading: !state || props.sessionBusy,
      onSwitchToNewThread: async () => { await props.onNewSession(); setSidebarOpen(false); },
      onSwitchToThread: async id => { await props.onActivateSession(id); setSidebarOpen(false); },
    } },
  });
  runtimeRef.current = runtime;

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

  const busy = props.sessionBusy || props.sending || running;
  const activities = session?.activities ?? [];
  const activeTool = [...activities].reverse().find(item => item.status === "running" || item.status === "in_progress");
  const suggest = (text: string) => { runtime.thread.composer.setText(text); inputRef.current?.focus(); };

  return <AssistantRuntimeProvider runtime={runtime}>
    <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      {sidebarOpen && <button className="sidebar-scrim" aria-label="Close conversation history" onClick={() => setSidebarOpen(false)} />}
      <aside className="app-sidebar" aria-label="Conversation history">
        <div className="sidebar-brand"><a href="/" aria-label="Canvagent home"><span className="brand-icon"><Icon name="board" size={19} /></span>canvagent</a><button className="icon-button sidebar-close" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}><Icon name="close" size={17} /></button></div>
        <ThreadListPrimitive.Root className="thread-list">
          <ThreadListPrimitive.New className="new-conversation" disabled={busy} aria-label="New conversation"><Icon name="compose" size={17} />New conversation<span>＋</span></ThreadListPrimitive.New>
          <span className="sidebar-label">Conversations</span>
          <div className="thread-list-items"><ThreadListPrimitive.Items>{() => <ConversationItem disabled={busy} />}</ThreadListPrimitive.Items></div>
        </ThreadListPrimitive.Root>
        <div className="sidebar-workspace" title={state?.project.workspace}><span className="workspace-icon"><Icon name="folder" size={17} /></span><div><strong>{state?.project.name ?? "Local workspace"}</strong><span>Local workspace</span></div>{state?.project.desktop ? <button className="icon-button" aria-label="Open workspace" title="Open another workspace" onClick={props.onOpenWorkspace}><Icon name="compose" size={16} /></button> : <span className={`status-dot ${props.online ? "online" : ""}`} />}</div>
      </aside>

      <div className={`main-workspace mobile-${mobilePane}`}>
        <header className="app-header">
          <div className="header-title"><button className="icon-button sidebar-toggle" aria-label="Open conversation history" onClick={() => setSidebarOpen(true)}><Icon name="sidebar" size={19} /></button><span className="header-project">{state?.project.name ?? "canvagent"}</span><span className="header-slash">/</span><span className="header-conversation">{titleFor(session)}</span></div>
          <button className={`runtime-status ${ready ? "ready" : "not-ready"}`} onClick={() => !ready && props.onConnect()} disabled={props.connecting} title={state?.runtime.error || `Codex ${state?.runtime.version ?? "runtime"}`}><span className={`status-dot ${props.connecting ? "pulse" : ""}`} />{props.connecting ? "Connecting…" : ready ? "Codex connected" : "Connect Codex"}{!ready && <Icon name="reconnect" size={13} />}</button>
        </header>
        <nav className="mobile-tabs" aria-label="Workspace view"><button className={mobilePane === "chat" ? "active" : ""} onClick={() => setMobilePane("chat")}><Icon name="chat" size={16} />Conversation</button><button className={mobilePane === "canvas" ? "active" : ""} onClick={() => setMobilePane("canvas")}><Icon name="board" size={16} />Canvas</button></nav>
        <main className="workspace-layout">
          <section className="conversation-pane" aria-label="Agent conversation">
            <div className="conversation-header"><label className="model-select"><Icon name="terminal" size={16} /><select aria-label="Agent model" value={state?.runtime.model || state?.runtime.models[0]?.id || ""} onChange={event => props.onChangeModel(event.target.value)} disabled={busy || !state?.runtime.models.length}>{state?.runtime.models.length ? state.runtime.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>) : <option value="">Codex</option>}</select><Icon name="chevron" size={13} /></label><span className="conversation-label">Conversation</span></div>
            <ThreadPrimitive.Root className="chat-thread">
              <ThreadPrimitive.Viewport className="transcript">
                {!session?.messages.length && !running && <div className="welcome">
                  <div className="welcome-symbol"><Icon name="terminal" size={25} /></div>
                  <h1>What are we working on?</h1>
                  <p>Bring an idea, a question, or a sketch.<br />Codex can work with you on the canvas.</p>
                  <div className="suggestions"><button onClick={() => suggest("Help me plan what to build in this workspace.")}><Icon name="spark" size={17} /><span>Plan something new<small>Turn an idea into a starting point</small></span><Icon name="arrow-right" size={15} /></button><button onClick={() => suggest("Read and inspect the shared canvas, then help me improve it.")}><Icon name="board" size={17} /><span>Explore the canvas<small>Think through what's on the board</small></span><Icon name="arrow-right" size={15} /></button></div>
                </div>}
                <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
                {running && <div className="working-line" role="status"><span className="working-spinner" /><span>{session?.status === "awaiting_approval" ? "Waiting for your approval" : activeTool?.title || "Codex is working"}</span></div>}
                {!!activities.length && <div className="activity-block"><button className="activity-toggle" aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}><Icon name="terminal" size={14} /><span>Tool activity</span><span className="activity-count">{activities.length}</span><Icon name="chevron" size={14} className={activityOpen ? "rotate" : ""} /></button>{activityOpen && <div className="activity-list">{activities.map(activity => <details className="activity-item" key={activity.id}><summary><span className={`activity-dot ${activity.status ?? ""}`} /><span>{activity.title}</span><span className="activity-state">{activity.status?.replaceAll("_", " ")}</span></summary>{activity.detail && <pre>{activity.detail}</pre>}</details>)}</div>}</div>}
                {props.sessionContent}
                <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom" aria-label="Scroll to latest message"><Icon name="down" size={17} /></ThreadPrimitive.ScrollToBottom>
              </ThreadPrimitive.Viewport>
              {!ready && state && <div className="connection-note"><Icon name="info" size={15} /><span>{state.runtime.error || (state.runtime.connected ? "Sign in with codex login, then reconnect." : "Connect Codex to start a conversation.")}</span></div>}
              <Composer runtime={runtime} props={props} running={running} ready={ready} inputRef={inputRef} />
            </ThreadPrimitive.Root>
          </section>
          {props.children}
        </main>
      </div>
    </div>
  </AssistantRuntimeProvider>;
}
