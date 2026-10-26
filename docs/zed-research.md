# Agent choice and workspace parity: Zed research

Researched 26 October 2026 against Zed commit [`087340e2d736737e66f6b8da9b3e3997e309bb09`](https://github.com/zed-industries/zed/commit/087340e2d736737e66f6b8da9b3e3997e309bb09). Links below are pinned to that commit. This is a source and documentation review, not a claim that every Zed feature was exercised. The Canvagent comparison describes the starting code at `d960b06`; changes made after this review should update the delivery checklist separately.

## Product direction

Make the conversation the primary entry point. Choose an agent beside the composer or when creating a conversation. Start its connection when needed. Put connection health, authentication, retry and diagnostics inside that agent's settings and in contextual errors. A permanent global **Connect Codex** action conflates an implementation detail, a provider preference and an account setup flow.

Support three distinct paths, with honest boundaries:

1. **Existing harness:** Codex's native app-server integration or an ACP-compatible process such as Claude Agent, OpenCode, Gemini CLI, or a custom executable. Each harness retains its execution loop, configuration and account relationship.
2. **API provider:** a Canvagent-owned agent loop using a selected model endpoint and API key. This requires tools, permissions, persistence and cancellation in addition to HTTP model calls. An API key does not itself supply a coding harness.
3. **Terminal:** any CLI/TUI can already run in the existing project PTY. A future terminal conversation can give it a first-class sidebar entry. A plain terminal does not imply structured ACP events, canvas tools or native thread resume.

Zed makes essentially this distinction in [Agents](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/agents.md), [LLM Providers](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/llm-providers.md), and [Terminal Threads](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/terminal-threads.md). These are useful product boundaries to adopt; Canvagent's shared canvas remains its own central feature.

## Source architecture worth adopting

### 1. Separate installation, process connection and conversation state

Zed's [`AgentServer`](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/agent_servers/src/agent_servers.rs#L51) creates a generic connection. [`AgentConnection`](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/acp_thread/src/connection.rs#L95) exposes session operations and optional capabilities. [`AgentConnectionStore`](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/agent_ui/src/agent_connection_store.rs#L87) tracks connecting, connected and error states by project and agent, including startup cancellation and owned-process shutdown.

For Canvagent, use a typed runtime interface under the current controller rather than teaching the controller ACP wire messages. Persist the selected agent's stable ID with the native thread ID. Existing sessions migrate to Codex. Agent selection for a new conversation must not silently resume another harness's native thread. Keep conversation-specific approvals, turns and canvas tokens even if connection reuse is introduced later.

### 2. Derive controls from capabilities

Zed's connection contract separately gates load/resume/history, close, logout, model selection, session modes, configuration options, title changes, retry and additional directories. Agent configuration options and prompt capabilities are separate concepts. See [`connection.rs`](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/acp_thread/src/connection.rs#L109) and the [ACP v1 implementation](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/agent_servers/src/acp/v1.rs#L1474).

Canvagent should expose a negotiated capability snapshot and render only meaningful controls. Codex reasoning effort, speed, sandbox settings and managed requirements cannot be sent unchanged to every harness. An external agent's absence of a model list does not mean it is unusable: its native configuration may choose the model. Distinguish local transcript retention from native session restoration.

### 3. ACP is a bidirectional protocol, not a prompt subprocess

Zed's [stdio transport](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/agent_servers/src/acp/transport.rs#L31) launches a process, preserves argument boundaries, reads newline-delimited frames and owns process cleanup. Its [v1 initialization](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/agent_servers/src/acp/v1.rs#L483) declares only implemented client capabilities and wires permission, filesystem, terminal and elicitation handlers. Session creation includes project directories and forwarded MCP servers.

Implement and test `initialize`, `session/new`, optional `session/load`, `session/prompt`, `session/update`, `session/cancel` and `session/request_permission`. Negotiate HTTP MCP support before forwarding the existing authenticated canvas endpoint. If a harness only accepts stdio MCP, provide an explicit bridge later or explain the missing capability; do not claim its canvas tools loaded. Leave unsupported filesystem/terminal callbacks unadvertised until handlers exist. Protocol definitions and expected flow are documented in the [official ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview).

### 4. Use the stable protocol; isolate experiments

At this commit, Zed's [`connect`](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/agent_servers/src/acp.rs#L123) uses ACP v1 normally. ACP v2 is behind `acp-beta`; it falls back to a fresh v1 process only for a recognized version mismatch. Arbitrary authentication or process failures do not trigger fallback.

Start Canvagent on stable v1. Keep version negotiation explicit and preserve the final typed error. Avoid broad retry loops that could duplicate authentication, session creation or task submission. Model version negotiation separately from connection recovery.

### 5. Preserve canvas semantics across different runtimes

Zed forwards configured MCP servers when creating or restoring external sessions; its [`new_session`](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/agent_servers/src/acp/v1.rs#L1312) sets up registration, modes and config before exposing the thread. It also has [bounded pending session updates](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/agent_servers/src/acp/session_updates.rs#L14) to handle notifications arriving during session creation.

Retain Canvagent's authoritative canvas service, revision checks, attribution, per-conversation authorization, retained artifacts and current-context-on-dispatch behavior. Convert runtime updates into the existing durable event vocabulary. Handle notifications before the session response and late updates after cancellation without assigning them to a newer turn.

### 6. Gate steering independently from chat and cancellation

Zed's [Agent Panel documentation](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/agent-panel.md#queueing-messages) says its **Steer** behavior applies to Zed Agent; external agents use the queue because Zed cannot detect the same turn boundaries. Cancellation and next-turn queueing remain available.

Canvagent already has a useful native Codex steering path. Preserve it. ACP support must not promise live canvas notices merely because prompts and notifications work. For a runtime without verified steering, retain changed revisions and deliver fresh canvas context when the queued message dispatches. Show this difference where the user sends an update, without presenting an internal protocol checklist during ordinary chat.

### 7. Make discovery extensible without requiring a marketplace first

Zed's [registry store](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/project/src/agent_registry_store.rs#L20) fetches and caches the ACP registry, filters platform distributions and carries metadata, binary targets and npm distributions. The [agent server store](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/project/src/agent_server_store.rs#L111) keeps sources, command resolution, environment and version/loading state separate. Custom executable definitions remain supported. Older extension-provided agents are migrated to registry entries rather than maintained as the preferred path.

Begin with useful presets and a **Custom ACP agent** form accepting an executable, argument array and environment references. Follow with an explicit registry installer: display source/version/platform, pin versions, verify available checksums, keep install/update/remove separate from starting a task, cache offline metadata and surface update errors. Never silently turn an unknown agent into `npx latest`.

The [current ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json), inspected on the research date, lists Claude Agent via `@agentclientprotocol/claude-agent-acp@0.96.0`, Codex via `@agentclientprotocol/codex-acp@2.2.2`, and OpenCode distributions invoked with `acp`. These are observed examples, not permanent version recommendations. Existing Codex app-server support remains valuable without an additional ACP wrapper.

### 8. Distinguish model credentials from harness credentials

Zed's [`LanguageModelProvider`](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/language_model/src/language_model.rs#L547) and [provider registry](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/language_model/src/registry.rs#L152) are separate from agent connections. Model metadata includes tool/image support and limits. Its [API-key state](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/language_model/src/api_key.rs#L134) uses credentials-provider storage and tracks environment-variable precedence.

Offer **Use existing agent login/configuration** for harnesses and **Use an API key** for direct model providers. Store reusable desktop secrets in an OS credential store, or reference server environment variables in a browser-only setup. Persist references and nonsecret metadata in ordinary project settings. Redact secrets from returned state, transport diagnostics and logs. A generic custom base URL must have an explicit credential association so switching hosts cannot accidentally reuse a key.

For direct model support, begin with explicitly described OpenAI-compatible Chat Completions and Anthropic Messages adapters. Responses-only endpoints require their own path; arbitrary endpoints need declared image/tool support and model IDs. Zed documents these differences in [Use API Access](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/use-api-access.md). Do not treat every endpoint as wire-compatible merely because it accepts bearer authentication.

## Relevant feature parity

“Present” means implemented in the starting Canvagent source/docs, not independently verified with every runtime or platform. The comparison prioritizes the shared agent workspace over reproducing an entire editor.

| Capability | Zed evidence | Canvagent starting point | Recommendation |
| --- | --- | --- | --- |
| Agent choice in new conversation | [Agent Panel](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/agent-panel.md#new-thread) | Global Codex connection status; Codex names in chat and settings | P0: agent picker at composer, contextual connection recovery |
| External harnesses and custom commands | [External Agents](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/external-agents.md) | One concrete `CodexRuntime` | P0: runtime interface, ACP v1, Claude/OpenCode presets, custom executable |
| API keys and custom endpoints | [API access](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/use-api-access.md) | Codex's existing auth/config only | P0/P1: credential references and direct provider loop with real tools |
| Multiple projects and parallel conversations | [Parallel Agents](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/parallel-agents.md) | Present: project sidebar, background runs, independent sessions | Preserve; show each conversation's agent and status |
| Thread history, archive, import | [Thread history](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/parallel-agents.md#threads-history) | Saved conversations and native Codex resume; no general ACP import/archive UI found | P1: archive/search/export; import only when agent advertises list and restore |
| Worktree isolation | [Git worktrees](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/git.md#git-worktrees) | Parallel agents share project files | P1: per-conversation checkout binding and explicit create/reuse picker |
| Review changes before accepting work | [Project Diff](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/git.md#project-diff) | Monaco file editing and disk conflict detection; no Git panel found | P1: read-only changed-files/diff panel first; hunk staging later |
| Tool activity and permission requests | [ACP connection](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/acp_thread/src/connection.rs) | Present for Codex, with input/approval handling | P0: normalize lifecycle; preserve exact agent-provided permission choices |
| Model, mode and config selection | [Session config options](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/crates/acp_thread/src/connection.rs#L391) | Rich Codex-only composer/settings | P0: capability-aware controls; per-agent defaults |
| Message queues and active-turn updates | [Queueing](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/agent-panel.md#queueing-messages) | Present: queue, explicit steer and live board notices | Preserve native steer; queue honestly for other runtimes |
| MCP configuration/discovery | [MCP](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/mcp.md) | Authenticated canvas MCP with current tool discovery | P0: forward canvas; P1: reusable local/remote MCP manager and tool status |
| CLI/TUI fallback | [Terminal Threads](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/terminal-threads.md) | Present: real PTY drawer with persistent project shells | P1: named terminal conversations; preserve native CLI ownership |
| Completion/attention notifications | [Terminal notification behavior](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/terminal-threads.md#terminal-thread-notifications) | Present: durable inbox and optional native/browser alerts | Reuse across adapters; avoid synthetic completion on cancel |
| Files, search, Vim and pane layout | [Editor-oriented and agentic layouts](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/parallel-agents.md) | Present: Monaco, project search, Vim, saved pane sizes | Preserve; add links from tool locations to file/line |
| Context mentions, inline edits and follow-agent | [Inline Assistant](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/inline-assistant.md), [Agent Panel](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/agent-panel.md#following-the-agent) | Canvas selection context; editor comments; no universal file/symbol mention system found | P1: file/selection chips, readable provenance, follow-agent opt-in; inline edits later |
| Instructions, skills and tool profiles | [Instructions](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/instructions.md), [Skills](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/skills.md), [Profiles](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/ai/agent-profiles.md) | Native Codex config plus additional instructions | P2: Canvagent-owned profiles/skills for its API loop; explain native harness boundaries |
| Repeatable tasks and setup hooks | [Tasks](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/tasks.md) | Interactive terminal only | P2: saved project commands, rerun and worktree setup hooks |
| Debugger | [Debugger/DAP](https://github.com/zed-industries/zed/blob/087340e2d736737e66f6b8da9b3e3997e309bb09/docs/src/debugger.md) | No DAP integration found | P3: evaluate after agent portability and review; substantial standalone work |
| Shared editable canvas, live website frames and artifact provenance | Canvagent-specific scope; no equivalent asserted by this review | Present | Keep central; every structured adapter must pass canvas contract checks |

Local evidence: `src/server/runtime.ts`, `src/server/app.ts`, `src/shared/types.ts`, `src/shared/settings.ts`, `src/server/canvas-mcp.ts`, `src/server/workspace-files.ts`, `src/server/terminals.ts`, `src/client/ChatWorkspace.tsx`, `src/client/AgentSettings.tsx`, `src/client/CodeEditor.tsx`, `README.md`, and the existing runtime/app/workspace/desktop/e2e tests.

## Phased implementation and exit checks

### P0: agent-neutral entry point and first portable runtime

- Introduce runtime/agent definition types and capability metadata. Keep Codex's adapter and saved native threads working. Migrate old sessions deterministically to Codex.
- Add persisted agent configurations and per-session agent identity. Keep executable paths and argument arrays separate; validate definitions without executing them. Expose redacted public settings.
- Replace header connection CTA with agent selection at the composer/new-conversation flow, an agent manager and contextual authentication/retry guidance. Label assistant messages with the bound agent.
- Implement stable ACP v1 process lifecycle, prompt streaming, tool activity, cancellation, native permission choices, session restore when supported and supported canvas MCP forwarding. Add presets and a custom command path.
- Add a direct API agent path only when its end-to-end tool loop is real. Begin with canvas tools and bounded workspace read/search/edit tools; apply approvals before file writes/commands. Advertise only implemented controls and tool capabilities.
- Verify a mock ACP subprocess that requests permission, streams tool updates, restores a session, cancels, disconnects and emits late events. Use protocol fixtures for API tool loops, incremental streams and cancellation. Exercise the UI chooser and retained existing Codex histories.

**Exit:** new conversations can choose Codex or a configured ACP agent without a top-right connection action. Unsupported features explain themselves. The selected agent can use the shared canvas through its supported tool transport, cancellation does not submit a second task, and reconnect never changes a conversation's native identity. API support is called complete only after an authenticated real model/tool interaction is exercised; fixtures alone prove adapter behavior.

### P1: daily-use interoperability and safe parallel work

- Add registry discovery/install/update with version and source visibility, offline cache and checksum handling. Add a guided Claude/OpenCode setup and an agent diagnostics page.
- Add credential-store integration for reusable API keys, explicit custom endpoint/model metadata and direct-provider model selection. Test that state, logs and exported configuration cannot reveal keys.
- Add changed-files/diff review and per-conversation worktree selection. Preserve pending file buffers during navigation and validate that background agents use their bound checkout.
- Add searchable archive, Markdown export and capability-gated native thread import. Import by stable agent/session identity; do not silently duplicate or replay native histories.
- Add reusable MCP configuration with status and reconnect, plus explicit context chips for files/editor selections. Keep the existing automatic canvas context path.

**Exit:** a user can complete and review a task with Claude, OpenCode, Codex and a direct API provider; run independent work in separate checkouts; and reopen/import supported histories after restart. Test real harness versions and record exact capabilities rather than claiming universal parity.

### P2: workflow depth

- Promote terminal sessions into named conversations when native TUI workflows justify it; show terminal identity and preserve auth/config ownership.
- Add project command definitions, rerun, setup hooks and useful file/line navigation from tool events.
- Add reusable instructions/skills and tool profiles for the Canvagent API agent. Show when a harness owns these features itself.
- Add context usage and compaction only where reliable metadata exists. Distinguish local transcript export, native compaction and creating a new conversation from a summary.
- Add optional follow-agent navigation and inline edit review without taking focus away during typing.

**Exit:** the app improves repeated agent work without presenting controls a selected runtime cannot honor.

### P3: broader editor parity, selected by actual use

Evaluate remote/SSH execution, multi-root projects, LSP-backed language services, DAP debugging, deeper Git operations and collaborative editing as separate projects. Zed's mature implementations show the scope; these should not block a complete local multi-agent canvas workspace. Require an explicit product case and acceptance checks for each rather than treating “feature parity” as a promise to copy every editor feature.

## Compatibility and validation principles

- Preserve uncertainty: an accepted or timed-out prompt cannot be blindly resent. Saving a transcript does not prove the native runtime can resume it.
- Keep live permissions bound to the originating conversation and request; no cross-agent approval translation by guessed names.
- Return structured canvas failures and retain revision/asset invariants for every adapter.
- Store credentials separately from ordinary settings and never send another provider's key to a changed endpoint.
- Treat agent-provided text, MCP output and registry metadata as data. User-configured processes execute with the user's chosen authority; ACP itself is not a sandbox.
- Distinguish source-confirmed design, mock/protocol verification and live model validation in release notes. Do not turn a tested handshake into a claim that every harness's full coding workflow works.
