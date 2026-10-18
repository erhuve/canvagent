# Data models and contracts

These are the target v1 boundaries for the [architecture](architecture.md). Implement the subset needed by each working slice, with runtime validation at browser and agent tool boundaries. Share schema definitions for types and tool inputs where useful. Examples describe application contracts, not unverified Codex protocol fields; they do not require a separate database table or generic framework for every model.

Start with project/session identity and native runtime binding, a saved board with managed image references, per-object metadata, and mutation request/result. Add turn/approval lifecycle, context-delivery tracking, artifacts, and reconnect events with their consuming features. A compact delivery cursor and pending summary can represent CanvasDelivery initially.

Use schema version 1, opaque string IDs, server-generated ISO timestamps, and nonnegative integer revisions. Reject unsupported schema versions explicitly. Application IDs remain distinct from provider thread, turn, and request IDs.

## Durable models

| Model | Important fields | Meaning and constraints |
| --- | --- | --- |
| Project | id, name, workspaceRoot, boardId, createdAt | One canonical local workspace and one board in v1. |
| Session | id, projectId, boardId, provider, providerThreadId, runtimeVersion, createdAt, updatedAt | A conversation using the project board. Persist native thread linkage for resume. |
| Turn | id, sessionId, userMessageId, providerTurnId, status, startedAt, endedAt, error | One user request and its agent work. One active turn per project in v1. |
| Message | id, sessionId, turnId, role, text, attachments, canvasReference, createdAt | User-visible conversation record. References stable IDs rather than embedding mutable file paths. |
| Board | id, schemaVersion, revision, sceneSchemaVersion, elements, assetBindings, updatedAt | Canonical native Excalidraw scene plus service-owned metadata. Selection and viewport are separate. |
| ElementMetadata | boardId, elementId, revision, createdBy, updatedBy, sourceTurnId, deleted | Server revision and attribution alongside each native element. Retain deletion tombstones; never reuse an ID for a different object. |
| BoardMutation | id, requestId, requestHash, boardId, actor, sourceTurnId, beforeImages, afterRevisions, resultingBoardRevision, createdAt | Durable accepted batch, retry receipt, and source for safe undo. |
| StoredFile | id, projectId, role, filename, mediaType, sizeBytes, sha256, storageKey | Immutable managed bytes. Role distinguishes source images, generated artifacts, and temporary captures. |
| Artifact | id, projectId, sessionId, turnId, fileId, title, createdAt | A published output with provenance; several board elements may reference it. |
| Approval | id, sessionId, turnId, runtimeRequestId, runtimeConnectionId, kind, details, allowedDecisions, decisionAttempt, status, createdAt, resolvedAt | Correlates one live provider approval request and its recorded outcome. |
| CanvasDelivery | id, sessionId, turnId, boardId, fromRevision, toRevision, scope, truncated, status | Records context delivery, not model understanding. Scope identifies overview, elements, region, or a resource notice. |
| SessionEvent | sessionId, sequence, type, turnId, payload, createdAt | Ordered application activity for UI recovery. Sequence is monotonic within a session. |

An element's service revision is independent of Excalidraw's native version and nonce fields. Persist native editor fields for round trips, but use the service revision for concurrency.

A stored file may be deduplicated by hash internally, while keeping stable references and provenance. Scene image file IDs map to managed file IDs through assetBindings. Artifact attachments record artifact IDs in validated element metadata; they do not store raw file contents.

Codex owns its native conversation history. Canvagent messages and events support UI presentation and board references. Reopening a session resumes its provider thread; it does not reconstruct that thread by replaying recorded tool executions.

## Turn and approval lifecycle

Turn states are starting, running, awaiting_approval, completed, failed, interrupted, and unknown. The unknown state means submission or execution outcome needs reconciliation. A browser disconnect alone does not interrupt a running provider turn.

A pending approval moves through answering to accepted, declined, canceled, expired, or unknown. Persist the decision attempt before sending it. The runtime's resolution event confirms the outcome. If a response is lost, reconcile the original request before another answer; never treat reconnect as approval.

Only one active turn can hold the project runtime slot. An explicit user update for a busy session is steered or visibly queued as a pending user message. Automatic canvas resource notices target the existing turn and are never queued as new user tasks. A queued message becomes a turn only when dispatched.

## Canvas references and context

A message can point to a board snapshot and selection:

```ts
type Region = { x: number; y: number; width: number; height: number };

type CanvasReference = {
  boardId: string;
  revision: number;
  elementIds: string[];
  region?: Region;
};

type CanvasContext = {
  schemaVersion: 1;
  boardId: string;
  revision: number;
  overview: string;
  selection: CanvasReference;
  changes: {
    sinceRevision: number | null;
    throughRevision: number;
    addedIds: string[];
    updatedIds: string[];
    deletedIds: string[];
    truncated: boolean;
    requiresRead: boolean;
  };
};
```

Before accepting a user instruction, flush pending browser edits and record its send-time reference against an acknowledged revision. At dispatch, rebuild context from the current board and resolve the selected IDs again; this matters when a message waited in a queue. Preserve the original reference for history, while latest-state reads remain the default. If a selected object was deleted, surface that change rather than silently targeting a different object. Historical inspection requires an explicit requested revision that is still retained.

Deliver a bounded overview and changed-object IDs automatically at session start, resume, and each user turn. Use explicit truncation and read-required flags when the board or change history exceeds the context budget. A persisted delivery is marked submitted only after the runtime accepts it; uncertain acceptance remains unknown until reconciled.

Keep a per-session overview-delivery cursor. Scoped tool reads record their own revision and scope, and do not mark the entire board observed. If detailed change history has been compacted, send a fresh overview and requiresRead rather than implying no changes occurred.

Board changes during an active run update the resource. Batch committed human edits after a short pause into this bounded notice:

```ts
type CanvasChangedNotice = {
  schemaVersion: 1;
  kind: "canvas_changed";
  boardId: string;
  expectedTurnId: string;
  sinceRevision: number;
  throughRevision: number;
  changedIds: string[];
  deletedIds: string[];
  truncated: boolean;
  requiresRead: boolean;
};
```

The controller supplies trusted provenance. Deliver through the verified active-turn input path, separately labeled from explicit user instructions. Keep one coalesced pending summary, skip agent-originated edits, and advance its delivery cursor only through the revision the runtime accepted. Newer edits remain pending. A notice delivery does not advance the separate overview-delivery cursor or claim the objects were inspected. If the active turn changes or ends, include remaining changes in the next context; do not dispatch a new turn for the notice.

Delivery happens at a runtime-supported processing boundary and can consume model tokens within that turn. The adapter declares whether this path works; unsupported live notices are visible and fall back to latest tool reads and next-turn context. Ordinary idle drawing never starts agent work. Explicit user updates bypass the debounce.

When asked to inspect the current canvas, the agent must read the relevant current objects and capture their visual region as needed before describing it.

## Canvas mutation contract

The browser and agent handlers share one mutation engine:

```ts
type CanvasOperation =
  | { kind: "create"; elementId: string; element: ElementInput }
  | {
      kind: "update";
      elementId: string;
      expectedRevision: number;
      patch: ElementPatch;
    }
  | { kind: "delete"; elementId: string; expectedRevision: number };

type CanvasMutationCommand = {
  schemaVersion: 1;
  requestId: string;
  boardId: string;
  observedBoardRevision: number;
  operations: CanvasOperation[];
};

type CanvasMutationResult =
  | {
      ok: true;
      mutationId: string;
      boardRevision: number;
      changedElements: ElementRecord[];
    }
  | {
      ok: false;
      code: "CONFLICT" | "VALIDATION_FAILED" | "NOT_FOUND" |
            "IDEMPOTENCY_KEY_REUSED" | "RESOURCE_UNAVAILABLE";
      message: string;
      boardRevision?: number;
      conflicts?: {
        elementId: string;
        expectedRevision: number;
        currentRevision: number | null;
        currentElement: ElementRecord | null;
      }[];
    };
```

ElementInput and ElementPatch are validated against the pinned editor model. The browser adapter can represent native editable content; the agent-facing tool schema exposes a supported subset: text, basic shapes, arrows/connectors, styling, placement, and existing managed images. The service generates native bookkeeping fields. ElementRecord includes native content and its service-owned metadata.

The trusted call context supplies actor, project, session, and turn identity. Agents cannot claim to be the user through tool arguments.

Rules:

1. Validate the entire batch, asset references, relation/binding integrity, and expected revisions before changing anything. A failed batch has no board side effects.
2. Compare only affected elements. observedBoardRevision provides provenance and must not be in the future; an older board revision is allowed when all affected object revisions still match.
3. A create requires a never-used element ID. Updates and deletes require a matching live object revision. Return the current affected objects on conflict.
4. Changes to bound text, containers, groups, or connectors include the relevant dependent edits and revision checks in the same batch. Preserve native drawing order. Phase 0 must exercise the actual editor's dependent edits and undo/redo echo behavior; start agent writes with proven operations and expand them as integration checks pass.
5. Commit snapshot, mutation record, request receipt, and board change event together, then acknowledge. Increment the board revision once per accepted nonempty batch and each affected object's revision once.
6. Scope request IDs to the authenticated actor and board. Same ID and canonical input returns the original result without new writes or events. Different input with that ID returns IDEMPOTENCY_KEY_REUSED. A rebased edit uses a new ID.
7. Publish the saved result to the browser with mutationId and requestId so it can reconcile its optimistic view and suppress update echoes.

The browser computes object differences against its acknowledged scene. It does not submit the entire onChange scene as a replacement. Unsaved edits remain queued when an agent event arrives. A same-object conflict keeps the user's pending edit available for resolution.

Undo names a mutationId and requestId. The service derives its inverse from beforeImages and checks that affected objects still have that mutation's resulting revisions. Undo is a new attributed batch; conflicts leave the board unchanged. Undoing a deletion may restore the same logical object from its tombstone through an internal restore operation; ordinary create never reuses a previously used ID. Native editor history and application mutation history must not apply the same inverse twice.

The implementation also accepts a trusted human-only restore operation for native editor undo after a saved deletion. It checks the tombstone revision and original ID/type; agent tools cannot use it. Native fractional drawing order is preserved in saved arrays. The browser keeps canonical snapshots separate from objects Excalidraw may mutate and defers remote scene injection until an active pointer gesture finishes. The latest agent mutation ID is retained so its guarded undo remains available after reload.

## Agent canvas tools

All tool requests and responses use schema version 1. Tools call the service directly through the provider adapter or through a transport such as MCP; behavior is identical.

| Tool | Input | Output |
| --- | --- | --- |
| read_canvas | boardId; scope: overview, elements, region, or changes; element IDs/region/sinceRevision as relevant; optional requested revision and page cursor | revision; overview or matching element records; affected/deleted IDs for changes; truncation and next-page cursor. |
| capture_region | boardId; region or selected element IDs; optional requested revision; bounded scale | revision actually rendered, bounds, media type, managed image reference, and image content when supported by the adapter. |
| apply_canvas_ops | CanvasMutationCommand with the supported agent element schema | CanvasMutationResult. |
| publish_artifact | requestId, permitted workspace-relative sourcePath, title; trusted session/turn context | Stable artifactId and file metadata after copying bytes to managed storage. |
| attach_artifact | requestId, boardId, artifactId, new element IDs, placement; expected revision for an existing anchor if supplied | Same atomic mutation result, with the artifact ID and created element IDs. |

A read returns one consistent committed revision, current by default. Captures pin their revision at request start and render that snapshot or report an explicit failure. Missing retained snapshots return SNAPSHOT_EXPIRED. Historical retention is bounded; v1 does not promise an indefinite timeline. Start with bounded scoped reads and explicit truncation; if pagination is added, its cursor pins the revision and query. Region coordinates use board coordinates, independent of browser zoom. Initial captures require a connected browser renderer and return RESOURCE_UNAVAILABLE when it is absent.

publish_artifact copies the generated file from the permitted project workspace, recording the resulting bytes as an immutable artifact. The same request ID returns the same published output; publishing changed source bytes requires a new request. This tool supplies the artifact ID that attach_artifact needs.

Artifact attachment first resolves a published artifact owned by the project, then creates a preview/reference through the mutation engine. Source bytes are already durable. Adding a preview cannot duplicate on retry.

## Runtime adapter contract

Keep native protocol details inside the adapter. The intended logical interface is:

```ts
interface AgentAdapter {
  capabilities(): {
    steering: boolean;
    canvasChangeNotices: boolean;
    imageInput: boolean;
    imageToolResults: boolean;
    resume: boolean;
    canvasTools: boolean;
  };
  openSession(input: OpenSessionInput): Promise<RuntimeBinding>;
  resumeSession(binding: RuntimeBinding): Promise<RuntimeBinding>;
  startTurn(input: StartTurnInput): Promise<TurnAcceptance>;
  steerTurn(input: SteerTurnInput): Promise<SteerAcceptance>;
  notifyCanvasChanged(input: CanvasChangedNotice): Promise<NoticeAcceptance>;
  interruptTurn(input: TurnIdentity): Promise<void>;
  answerApproval(input: ApprovalAnswer): Promise<ApprovalAcceptance>;
  events(): AsyncIterable<RuntimeEvent>;
}
```

- RuntimeBinding contains provider, native thread ID, supported CLI version, and connection identity.
- OpenSessionInput binds the canonical workspace, session instructions, model choice, supported tool definitions, and policy settings. Tool calls route to handlers with trusted session/turn context.
- StartTurnInput contains the app request/turn IDs, explicit user message, canvas context, and optional resolved image/file attachments. It returns the native turn identity or an explicit uncertain outcome.
- SteerTurnInput includes the expected active native turn identity. Unsupported steering queues visibly at the controller; it is not silently emulated by a second concurrent run.
- notifyCanvasChanged uses the verified steering/input route to label a resource notice and returns accepted, unsupported, stale-turn, or unknown. Unknown delivery is not automatically resent; later reads/turn context supply current state. This method is a small adapter wrapper, not a separate notification runtime.
- ApprovalAnswer names the stored live approval and one of its provider-advertised decisions. The adapter does not invent a stronger decision.
- RuntimeEvent is a discriminated union for text.delta, message.completed, tool.started, tool.updated, tool.completed, canvas_tool.requested, approval.requested, approval.resolved, turn.started, turn.completed, turn.failed, turn.interrupted, and connection.changed. Preserve native IDs for correlation and bounded diagnostic payloads for debugging.
- Turn completion and interruption are terminal runtime events. An accepted interrupt request alone does not prove execution stopped.

Register canvas tools before the first turn. Phase 0 proves the concrete binding, image handling, native approval route, and active-turn notice behavior against the pinned runtime; cancellation and resume are completed with the harness lifecycle. An adapter is capability-specific; it does not promise provider transcripts or threads can migrate between vendors.

## Browser/service transport

Use typed HTTP commands for mutations and session actions, plus a WebSocket event stream. Keep all APIs local and authenticated.

| Command | Required identity | Outcome |
| --- | --- | --- |
| Create/resume session | projectId, optional sessionId, requestId | Session snapshot and current runtime state. |
| Send user message | sessionId, requestId, text, acknowledged CanvasReference, attachments | Accepted turn or visibly queued message. |
| Send active-run update | sessionId, requestId, expected turnId, text, CanvasReference | Steered, queued, or explicit rejection. |
| Interrupt turn | sessionId, turnId, requestId | Request accepted; terminal state follows as an event. |
| Answer approval | sessionId, turnId, approvalId, requestId, advertised decision | Answer acceptance followed by runtime resolution. |
| Edit/undo canvas | boardId, requestId, expected object revisions or mutationId | Atomic mutation result. |
| Publish artifact/import image | projectId, session/turn provenance when present, bytes or a permitted local source | Stable managed file/artifact identity after bytes are durable. |

Commands have request IDs and durable acceptance receipts. A repeated send returns the existing message/turn rather than starting duplicate work. After an ambiguous runtime submission, return unknown and reconcile before dispatching again.

Session events use a per-session sequence; board events carry a board revision and mutation ID. The client reconnects with its last session sequence and board revision. The service replays available events and supplies snapshots when history has been compacted. Replayed events update UI state only.

Persist terminal message/tool states and approval state; streaming text deltas may be coalesced into checkpoints. Reconnection combines the latest checkpoint with subsequent events and can resynchronize from provider history where supported. Bound tool-output sizes while retaining exit state and diagnostic references.

## File lifetime and schema evolution

Write managed file bytes to a temporary file, finish and hash them, then move them into their durable location before committing database references. Do not acknowledge an import or artifact attachment before its bytes are available.

V1 can retain managed files without automatic cleanup. If cleanup is later added, it removes only unreferenced files after a grace period and preserves references from boards, artifacts, and undo history. Missing or corrupt bytes produce a visible unavailable state, rather than an empty successful preview.

Store application schemaVersion and native sceneSchemaVersion. Back up local data before migrations; reject newer unsupported versions without rewriting them. Future exports must include referenced image/artifact bytes and their manifest to be portable. Export packaging is a later extension, not a claim that a scene JSON file contains all assets.

See the [roadmap](roadmap.md) for phase gates that validate these contracts.
