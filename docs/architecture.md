# Architecture

Canvagent is a local agent harness with chat and a persistent canvas shared by the user and agent. The first implementation reuses Codex's runtime and embeds Excalidraw. The local Canvagent service coordinates both surfaces and owns the saved board.

This is the proposed v1 design. The [roadmap](roadmap.md) grows a small working application incrementally; the [contracts](contracts.md) describe the target boundaries, implemented as their features arrive. See the [adversarial review](adversarial-review.md) for the practical tradeoffs.

## Scope and deployment

Run one local Node.js service and open its React interface in a browser. The service lazily starts a Codex app-server subprocess over stdio for each conversation that connects or sends work. Use TypeScript across Canvagent.

V1 supports one open project, one board per project, parallel conversations with one active agent turn per conversation, and one editing browser connection. Runtime connections, dispatch queues, approvals, and coalesced canvas notices belong to individual sessions. Navigation does not stop background work. Projects can have multiple saved sessions; each session is associated with that project's board. Reopening an old session shows the current board and its intervening changes. Historical board revisions are read-only context, rather than an automatic rollback.

Use SQLite for application metadata, board snapshots, operation receipts, and durable event records, plus a local managed directory for image and artifact bytes. Provider conversation history remains owned by Codex; Canvagent stores the provider thread reference and the UI records it needs. Storage lives in the user's application data directory, separate from project source files.

No hosted backend or human multiplayer is required for v1. The local service binds to loopback and authenticates its browser connection; provider credentials stay in the runtime's supported authentication system.

## Components

```mermaid
flowchart TB
    UI["React interface: chat, tool activity, approvals"]
    EC["Embedded Excalidraw editor"]
    SC["Session controller and context builder"]
    CS["Canvas and artifact service"]
    RA["Codex adapter"]
    RT["Codex app-server subprocess"]
    RW["Browser capture adapter"]
    DB["SQLite and managed files"]
    MCP["Authenticated local canvas MCP"]

    UI <-->|"commands and session events"| SC
    EC <-->|"object edits and board events"| CS
    SC <-->|"context and canvas tool calls"| CS
    SC <-->|"messages and normalized events"| RA
    RA <-->|"local stdio protocol"| RT
    RT <-->|"current tools on start and resume"| MCP
    CS <-->|"render committed snapshot"| RW
    CS <--> DB
    SC <--> DB
    MCP <-->|"same canvas contracts"| CS
```

| Component | Owns |
| --- | --- |
| React interface | Conversation presentation, input, tool activity, approval prompts, connection and save state. |
| Excalidraw adapter | Native editor integration, selection, optimistic drawing, conversion to object patches, and rendering accepted board changes. |
| Session controller | Project/session association, turn lifecycle, explicit user instructions, event routing, and pending approval correlation. |
| Context builder | Bounded board overview, changed-object summaries, selection references, and delivery receipts. |
| Canvas service | Canonical board state, revision checks, atomic mutations, undo records, image references, and artifact attachment. |
| Capture adapter | Initially asks the connected browser to export a committed board snapshot with its managed image files. Returns an explicit unavailable result when no renderer is connected. |
| Codex adapter | Translation between Canvagent contracts and a pinned app-server version, tool registration, streaming, cancel, resume, and approvals. |
| Codex runtime | Agent loop, model interaction, built-in file and command tools, execution policies, sandbox, and provider conversation history. |

These are modules within one application. Start with a single Codex integration and ordinary functions between modules. A general provider framework, independent render worker, and event-sourcing system are not prerequisites.

## State ownership

The backend is authoritative for committed board state. The browser has an optimistic working view and a queue of unsaved changes. Both human edits and agent edits pass through the same canvas service.

Persist the native Excalidraw scene payload and managed image references. Add Canvagent-owned revisions and attribution alongside native elements. Do not build a second, independently editable shape database. The agent receives a simplified read projection; its write tools expose a limited set of validated shape operations.

Selection, hover, viewport, and in-progress pointer motion are client interaction state. They do not advance the saved board revision. A user send first flushes pending drawing changes, then submits a request referring to the acknowledged revision and selection. If saving fails, show the failure and retain the pending edits.

The service serializes committed mutations. Each successful batch increments the board revision once and commits the snapshot, history, idempotency receipt, and board event in one SQLite transaction. Updates and deletes check the expected revision of every affected object. Changes elsewhere on the board do not cause a false conflict.

## User request and agent response

1. The user sends a message, optionally with selected objects or a region. The UI flushes and acknowledges pending board edits first.
2. The controller records the user message and its send-time board reference. When the message is dispatched, it creates a turn and builds fresh canvas context from the current committed board, resolving selected objects by their stable IDs.
3. The adapter submits the instruction and clearly separated canvas context to Codex. Context identifies the board and available canvas tools even when no objects were explicitly selected.
4. Codex performs normal work. A canvas tool call returns through the adapter to the same canvas service the browser uses.
5. A validated agent edit commits atomically, records attribution, and broadcasts the new board revision. The editor reconciles that update without echoing it back as a human edit.
6. The agent calls publish_artifact for a generated workspace file, receives a stable artifact ID, then uses attach_artifact to place its preview or reference on the board.
7. Chat and tool events continue normally; the runtime completes, fails, or interrupts the turn.

Canvas tool failures return structured results to the agent so it can inspect current state and recover. A failed annotation does not erase the conversation or falsely mark ordinary project work as complete.

## Canvas awareness

Session instructions describe the canvas and when to use it. Every user turn includes a compact current overview, the context revision, selection, and changes since the session's last delivered canvas context. Large object lists and images are fetched on demand through tools.

A delivery receipt tracks what context was submitted to the provider. It does not claim the model understood or fully inspected the whole board. A regional tool read also records its scope and revision; it does not advance a global observation cursor past unseen changes.

While a turn runs, coalesce committed human edits into a short, debounced resource notice containing the board revision and changed/deleted object IDs. Deliver it to the expected active turn through the runtime's verified steering/input path at its next supported processing boundary. Keep at most one pending summary and combine new changes while delivery is in progress. Agent-originated edits do not trigger these notices.

A notice says that the shared resource changed; it does not turn board text into a new task. It may cause another model step within the existing turn. It never starts or restarts a turn, and idle drawing stays idle. Record the revision actually accepted by the runtime; retain subsequent or undelivered changes. If the turn ends before delivery, carry them into the next turn's context.

Automatic mid-run notices are a product target to verify in phase 0. If the chosen runtime cannot deliver them, show that live notices are unavailable and keep the latest state available through reads and next-turn context. That fallback is an explicit early limitation, not a claim of live delivery.

An explicit "Send update to agent" action sends a user instruction immediately through supported steering, or visibly queues it. It bypasses the drawing debounce. The agent's next canvas read always sees current committed state by default.

Board text and imported images are supplied as user-authored context, separate from application instructions. The agent may inspect and annotate proactively as part of a requested task. Session guidance requires a fresh read and, for visual claims, a capture when asked to inspect the current canvas; a compact overview alone does not establish what the drawing looks like.

A message's saved CanvasReference documents what the user pointed at when sending it. It does not freeze every later read to that revision. Current reads are the default, including after a queued message dispatches. Explicit historical requests may name a retained revision; missing snapshots return a clear unavailable result. Deleted selected objects remain visibly missing instead of being replaced by other targets.

## Rendering and artifacts

Initially use Excalidraw's export code in the connected editing browser. Export a supplied committed snapshot, including its managed image files, rather than taking a screenshot of an optimistic editor view with unsaved changes. Phase 0 proves text, images, and region bounds through this path. If the browser disconnects, capture_region returns RESOURCE_UNAVAILABLE while the normal agent session may continue.

Browser-independent rendering is a later improvement when closed-browser use becomes valuable; it is not an early build gate.

Every capture names the board revision actually rendered. A slow render never silently substitutes a newer board. If that revision is no longer available, return an explicit error.

An artifact is an immutable managed file with a stable ID, media type, byte size, and content hash. Copy useful outputs from the project into managed storage before attaching them. A board attachment points to the artifact ID, not a temporary path or expiring preview URL. Pasted source images use the same managed-byte storage, with a distinct asset role.

## Runtime integration

Use a small adapter around Codex app-server. The first slice verifies a real thread, streaming, canvas tools, image delivery, and the native approval route. Probe mid-run notice delivery and record what works. Extend cancellation, reconnect, and resume alongside the normal session lifecycle instead of blocking the first drawing demo on all of them. Record the working CLI version and authentication path.

Supply current canvas tools through an authenticated local MCP connection configured at thread start and resume. This lets saved conversations gain updated schemas while retaining their original native thread and full context. Verify the catalogue before starting a turn. Legacy native dynamic-tool callbacks remain supported for older histories; they use the same handlers, schemas, revision checks and storage. Browser credentials and MCP credentials are separate, and MCP calls require the originating conversation's active turn.

The adapter declares capabilities such as steering and image tool results. Unsupported capabilities have explicit behavior. Canvagent forwards approval decisions against the exact live runtime request; board clicks never implicitly grant command execution permission.

After an uncertain submission or a lost runtime connection, reconcile the existing turn before starting another. Reconnect does not blindly resend instructions or approvals. If the runtime has exited, keep the transcript and board, mark the run interrupted or unknown as appropriate, and offer resume.

## Persistence and recovery

Saved means the backend acknowledged a durable transaction. The UI shows saving, saved, disconnected, and conflicted states. On reconnect, fetch a current board snapshot and replay durable session events after the client's cursor. Replay events update presentation and never repeat their side effects.

Store assets completely before committing scene references to them. A crash can leave an unreferenced file, which can be cleaned up later; it must not leave a successfully acknowledged board pointing to bytes that were never written.

Start with small boards, current snapshots, and straightforward request receipts. Add message checkpoints and event recovery with the harness lifecycle; broad history retention, cleanup automation, and exhaustive recovery matrices can follow actual need.

Undo is a new revision-checked mutation derived from the original batch's before-images. It cannot restore an entire old board over later edits. If affected objects changed afterward, report a conflict and let the user inspect it.

## Later extensions

Expose the existing canvas service over MCP for external clients. Add another agent adapter against the same session and tool contracts. Human multiplayer would require a separate review of editing leases, presence, and merge behavior; it is not assumed to work through v1's single-editor optimistic patches.

See [data models and contracts](contracts.md) and [phases of work](roadmap.md) for implementation details and completion criteria.

## Primary references

- [Codex app-server protocol](https://developers.openai.com/codex/app-server/)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Excalidraw editor API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api)
- [Excalidraw export utilities](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/export)
