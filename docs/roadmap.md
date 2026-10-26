# Phases of work

## Agent portability and Zed-inspired delivery — October 2026

The [source review and feature matrix](zed-research.md) records the research, alternatives, dependencies, and acceptance checks against an immutable Zed commit. This delivery order extends the original phases below.

| Milestone | Implementation | Status |
| --- | --- | --- |
| Agent choice belongs to conversations | Composer picker, agent manager, contextual retry, stable session ownership, existing-session migration | Implemented |
| Bring an installed harness | Native Codex; ACP v1 Claude Code/OpenCode/Gemini presets; configurable executable/args/env references | Implemented; authenticated external inference needs live verification |
| Shared canvas across harnesses | HTTP MCP negotiation plus stdio bridge; text/tool activity, exact permissions, cancel, advertised native resume | Implemented and fixture-tested |
| Bring a model API | OpenAI-compatible and Anthropic loop; canvas/artifacts; workspace read/search/edit/create and approved executable commands | Implemented; paid provider inference needs live verification |
| Review completed work | Changes panel plus conversation-linked before/after snapshots, canvas reveal, and guarded file restoration | Implemented |
| Smooth agent setup | Capability-aware diagnostics, explicit registry discovery/install with pinned versions, native credential store, API response streaming | Next |
| Safer parallel coding | Conversation-bound worktrees, setup hooks, diff/hunk staging, worktree lifecycle | Next, after review panel |
| Visible chat context and images | @mentions, file/line/canvas/conversation/artifact chips, frozen previews, clipboard/drop/file images, persisted multimodal messages | Implemented |
| Reusable context and history | MCP manager, search/archive/export, capability-gated import | Follow-up |
| Deeper workflows | Named terminal conversations, saved commands, skills/profiles, follow-agent and inline edit review | Follow-up |
| Editor expansion | LSP, DAP, SSH, multi-root and collaboration evaluated separately with product cases | Later |

Ship gates: keep existing native Codex identity and runtime tests passing; exercise ACP/API with deterministic local fixtures; verify keys never appear in returned or persisted configuration; verify approval denial/cancel prevents tools; check actual browser navigation and picker behavior. See the [validation record](agent-portability-validation.md). Mock protocol coverage is not evidence of authenticated model inference. Record live harness versions when that validation is performed.

The next worktree milestone must bind runtime cwd, terminal cwd, file access, Git review, and canvas/artifact ownership explicitly. Preserve background turns and drafts during navigation, and never silently move existing native sessions to another checkout. Registry installation and OS credential persistence remain separate from choosing an agent or starting a task.

## Original local-v1 phases

Build a conventional local agent harness with a shared canvas available throughout each session. Keep a small end-to-end application running as capabilities are added.

The local-v1 code described by phases 0 through 5 is now implemented. Automated store, protocol, application, and browser checks exercise the shared interaction. Real model inference and its live canvas behavior still need verification with a fresh Codex login; the inherited cloud login returned an authorization error. See [implementation evidence](implementation.md#runtime-status) for the precise boundary. The phases below retain their goals and acceptance checks for ongoing development.

## Phase summary

| Phase | Result | Depends on |
| --- | --- | --- |
| 0. Small integration loop | Chat, canvas inspection, and an editable agent response in a runnable application. | None |
| 1. Save the working loop | Reopen the same board/images/session association; basic shared-edit correctness. | 0 |
| 2. Ordinary session lifecycle | Tools, native permissions, cancellation, reconnect, and resume. | 1 |
| 3. Awareness and live notices | Current context, automatic active-turn notices, and convenient visual references. | 1, 2 |
| 4. Generated outputs on the board | Publish a workspace file and attach its durable preview or reference. | 3 |
| 5. Local v1 | Focused recovery checks and a reproducible installation. | 4 |

The [architecture](architecture.md) assigns responsibilities. The [adversarial review](adversarial-review.md) explains why this sequence favors a working loop early.

## Phase 0 Small integration loop

**Goal:** prove the actual runtime and editor interaction before investing in infrastructure.

**Work:**

- Start Codex app-server, create a real thread, stream chat, and bind canvas read/write tools to local handlers.
- Draw in embedded Excalidraw, send "look at the canvas," and have the model inspect structured objects plus a region image exported through the connected browser.
- Have the agent add editable text or a basic shape. Keep this application as the implementation seed.
- Test the difficult editor boundary: a pending human drag, an incoming agent annotation, acknowledgment of the drag, then undo. Both participants' changes must survive without echoing edits or applying undo twice.
- Probe native approval routing and automatic active-turn resource notices. Record the exact runtime/editor versions, authentication path, tool transport, and supported behavior.

**Exit check:** draw → ask Codex → visual inspection → editable annotation appears, using the real runtime. Record the proven update/history strategy and initially restrict agent writes to operations it supports.

Automatic mid-run delivery must be demonstrated before claiming it works. If unavailable, make that an explicit limitation of the early slice and revisit the runtime route for phase 3. Do not block the basic drawing loop on independent headless rendering, every lifecycle case, or a complete provider abstraction.

**Output:** a small runnable application and a brief integration decision record.

## Phase 1 Save the working loop

**Goal:** use and reopen the first durable shared experience.

**Work:**

- Add the immediate schemas: project/session identity and runtime binding, board snapshot, image references, object revisions, and mutation request/result.
- Persist metadata/board state with SQLite and copied image bytes in managed storage.
- Apply atomic edit batches with stable IDs, per-object revision checks, request receipts, and attribution.
- Retain pending browser edits when agent changes arrive; surface same-object conflicts.
- Group agent edits for revision-checked undo. Use phase 0's supported editor operations and expand them only as checks pass.

**Exit check:** draw → ask → editable agent result → close/reopen with the board, images, and session association intact. Independent edits survive, same-object conflicts are explicit, repeated requests do not duplicate annotations, and undo does not erase later changes.

**Output:** the first personal-use slice. Source images and basic edit correctness are included from this point.

## Phase 2 Ordinary session lifecycle

**Goal:** grow the same application into a comfortable normal agent harness.

**Work:**

- Add session creation/reopening, tool activity, visible native approvals, cancellation, and provider-thread resume.
- Add turn/message/approval records and UI checkpoints as these features need them.
- Add explicit active-run instructions and a visible queued-message fallback.
- Reconcile uncertain submissions and runtime disconnects without blindly replaying work.
- Add bounded application events for UI reconnect; avoid building a general event-sourcing system.

**Exit check:** complete a real project task, deny an operation, interrupt a turn, reconnect, and continue the same provider thread. Reconnect does not launch duplicate tasks or silently accept approvals.

**Output:** normal agent workflow alongside the working canvas.

## Phase 3 Awareness and live notices

**Goal:** make the board naturally available throughout the session.

**Work:**

- Supply board identity, bounded overview, selection, and change summaries at session start/resume and each turn.
- Flush drawing edits before recording a user message's reference. Rebuild current context when a queued message dispatches.
- Coalesce committed human edits during a run into a bounded, debounced canvas_changed notice for the expected active turn.
- Skip agent-authored edits, retain undelivered changes, and avoid starting new turns for idle drawing.
- Add "Ask about selection" and explicit "Send update" conveniences over the normal message flow.
- Track delivery revisions without treating scoped reads or notices as proof the model saw the entire board.

**Exit check:** while Codex works, edit the board and demonstrate a notice reaching the active turn at a supported boundary. The agent can read the changed objects and draw back. Its own drawing causes no notice loop. A queued request gets current state and reports deleted targets.

If live notices remain unsupported, state that visibly and revisit the integration decision; next-turn refresh is not labeled live collaboration.

**Output:** verified canvas awareness and active-turn updates.

## Phase 4 Generated outputs on the board

**Goal:** connect ordinary project work to persistent visual results.

**Work:**

- Expose publish_artifact(requestId, sourcePath, title), copying a permitted workspace file into managed storage and returning its artifact ID.
- Expose attach_artifact to place a native image preview or labeled reference on the board.
- Link chat messages to relevant board objects, and show useful states for deleted objects or unavailable files.
- Support agent annotations beside the originating sketch and continued work from user corrections.

**Exit check:** sketch or screenshot → user request → normal tools/project changes → published output and editable explanation on the board → user correction → continued work. Reopen and verify images and artifacts still resolve.

**Output:** complete visual communication and artifact loop.

## Phase 5 Local v1

**Goal:** make the implemented path dependable enough for regular personal use.

**Work:**

- Check browser reconnect, runtime failure, repeated commands, stale edits, denial/expired approvals, and an interrupted image import.
- Verify saved board/image/artifact references survive restart and that uncertain runtime outcomes remain visible.
- Document setup, supported versions/capabilities, data location, backup, and the single-editor limitation.
- Retain managed files initially; defer automatic cleanup and broad historical retention.
- Run the full workflow on a fresh installation.

**Exit check:** the implemented workflow passes focused integration checks; save state, conflicts, and runtime failures are visible. No successfully acknowledged board references incompletely stored image bytes.

**Output:** local v1, grown from the initial runnable slice.

## After v1

Consider browser-independent rendering, an MCP interface for external clients, another provider adapter, portable export, richer previews, multiplayer, and hosted deployment when they solve an observed need. General history pagination and cleanup automation can follow growing data volumes.

Keep authoritative board state, atomic mutations, object revision checks, durable images, and safe undo throughout. Those protect actual work; they do not require a production platform before the first demo.
