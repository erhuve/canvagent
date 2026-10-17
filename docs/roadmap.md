# Phases of work

Build a conventional local agent harness with a shared canvas available throughout each session. The first release is complete only when normal agent work and the canvas work together, including durable images, artifacts, conflict handling, and safe undo.

This is a planning roadmap. No phase is implemented yet. Each phase starts after its dependencies pass; phases 0 through 5 define the local v1 release. Dates and effort estimates should follow the phase 0 findings.

## Phase summary

| Phase | Result | Depends on |
| --- | --- | --- |
| 0. Integration feasibility | Prove the real runtime and editor path; pin versions and capability decisions. | None |
| 1. Models and durable state | Establish shared schemas, storage, and revision-checked mutation engine. | 0 |
| 2. Ordinary agent harness | Deliver chat, tools, permissions, cancellation, and session resume. | 1 |
| 3. Shared canvas and awareness | Connect human and agent editing with automatic context and safe undo. | 1, 2 |
| 4. Complete project workflow | Publish artifacts and continue work from visual feedback. | 3 |
| 5. Recovery and local release | Validate failure handling and ship a reproducible local installation. | 4 |

The [architecture](architecture.md) assigns component responsibilities. The [contracts](contracts.md) define the models and behavior each phase implements.

## Phase 0 Integration feasibility

**Goal:** remove uncertainty in the two third-party boundaries before building the application around them.

**Work:**

- Start the actual Codex app-server, initialize a thread, stream a turn, and bind a canvas tool to local handlers.
- Exercise a native execution approval, both acceptance and denial, cancellation, and thread resume after restarting the application connection.
- Embed Excalidraw; read selection and elements; add an editable agent annotation.
- Render a saved board region containing text and a pasted image through a local worker without the editing browser.
- Verify image input or image tool-result delivery reaches the model.
- Record the tested CLI/editor versions, authentication path, provider capability matrix, and concrete tool transport.

**Exit gate:** a small real vertical slice demonstrates structured board read, regional image understanding, and an editable response, plus working approval and resume behavior. Record unsupported optional behavior, such as steering, with its explicit fallback. If a required capability fails, revise the integration choice before phase 1.

**Output:** short integration decision record and disposable spike. A connection to this hosted chat is not assumed.

## Phase 1 Models and durable state

**Goal:** make shared content safe to build on.

**Work:**

- Define runtime-validated schemas for projects, sessions, turns, messages, board snapshots, element metadata, mutations, managed files, artifacts, approvals, context deliveries, and events.
- Add SQLite migrations and managed file storage outside project source files.
- Implement atomic canvas mutation batches, per-object revisions, tombstones, attribution, and durable idempotency receipts.
- Separate native scene data from viewport/selection state; preserve source-image bytes and file bindings.
- Implement snapshot/read APIs, service authentication, and enforcement of one active turn and one editing browser in v1.

**Exit gate:** storage and mutation checks prove round-trip persistence, independent object edits, same-object conflicts, duplicate-request handling, and recovery from an interrupted file/database write. A committed board cannot reference an incompletely written image. Reusing a request ID with different arguments fails.

**Output:** shared schema module, repository/storage layer, canvas engine, and focused contract tests.

## Phase 2 Ordinary agent harness

**Goal:** complete a normal agent task before adding dependence on visual input.

**Work:**

- Build project/session creation and reopening, chat, streamed responses, tool activity, and visible permission requests.
- Implement the Codex adapter and normalized event mapping using phase 0's verified protocol.
- Persist native thread/turn references, message checkpoints, approval state, and reconnect cursors.
- Add cancellation, explicit steering where supported, and a visible queued-message fallback.
- Reconcile unknown submission/approval outcomes and runtime restarts.

**Exit gate:** use the UI to complete a real repository task, deny an operation, interrupt a turn, reconnect the browser, and continue the same provider thread. Reconnect must not launch duplicate work or silently accept a pending approval.

**Output:** working local harness with ordinary chat, workspace tools, runtime permission controls, and resume.

## Phase 3 Shared canvas and awareness

**Goal:** make the board a persistent resource both participants can use naturally.

**Work:**

- Add the Excalidraw pane with optimistic local edits, saved-state indicators, and reconciliation against backend acknowledgments.
- Flush pending edits before a user request captures its board selection.
- Register read_canvas, capture_region, and apply_canvas_ops through the verified provider tool binding.
- Supply board identity, bounded overview, selection, revision, and change summary at session start/resume and every user turn.
- Keep scoped reads and context-delivery receipts distinct.
- Add attributed agent edits, revision-checked undo, and clear conflict resolution.

**Exit gate:** the agent can discover the board without a special attachment, inspect a selected drawing and screenshot, and add editable notes. Human edits to another object survive an agent batch; same-object races conflict explicitly. Undo cannot erase a later edit. Drawing alone does not start agent tasks.

**Output:** shared canvas usable within a normal conversation, with durable edits and safe interaction.

## Phase 4 Complete project workflow

**Goal:** connect visual communication to actual work and durable outputs.

**Work:**

- Implement source-image import, artifact registration, and attach_artifact.
- Copy published file bytes into managed storage and add native image previews or labeled links to the board.
- Keep chat-to-board references navigable; show meaningful status for deleted targets and unavailable files.
- Allow the agent to annotate progress and results beside the originating sketch.
- Carry a user's revised selection into a subsequent request or explicit active-run update.

**Exit gate:** demonstrate sketch or screenshot → user request → normal agent tools and project changes → editable explanation and output preview on the same board → user correction → continued agent work. Close and reopen the app; verify conversation linkage, board content, images, and artifacts.

**Output:** the full product loop, ready for release verification.

## Phase 5 Recovery and local release

**Goal:** make the integrated loop dependable on a fresh local installation.

**Work:**

- Exercise service and runtime crashes, browser reconnects, interrupted uploads, unavailable render workers, duplicate requests/events, stale edits, expired approvals, and unknown submissions.
- Validate bounded context/pagination, old-session reopening against a changed board, and explicit resynchronization after compacted history.
- Verify retained undo history and artifact references prevent premature file cleanup.
- Add setup, runtime prerequisites, supported version/capability matrix, storage/backup instructions, and recovery guidance.
- Run a clean-install smoke workflow and document the local single-editor limits.

**Exit gate:** the phase 4 workflow succeeds from a fresh installation; focused lifecycle and concurrency checks pass; no successful save loses board content or image/artifact references. The UI distinguishes unsaved, saved, conflicted, disconnected, and uncertain runtime state.

**Output:** first usable local release. Application implementation begins only after the planning stage.

## After v1

Add an MCP interface over the existing canvas handlers, then validate another provider adapter. Portable board/artifact export, richer previews, simultaneous agents, human multiplayer, and hosted deployment are separate follow-up scopes.

Do not require those extensions to validate the local Codex-backed shared-canvas experience.
