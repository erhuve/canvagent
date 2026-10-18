# Practical adversarial review

Reviewed the [initial detailed plan](https://github.com/erhuve/canvagent/tree/273d1904f498c5246db3a76b46dc75b56454c38f) on 18 October 2026 against the intended experience: an ordinary agent harness with a canvas both participants use during work.

The architecture is viable. The main uncertainty is whether the actual runtime and editor integration produce a good shared interaction. Build and use that loop before investing in broader infrastructure. This review changes planning documents; no runtime behavior has been tested yet.

## Material findings and decisions

| Finding | Concrete failure | Smallest correction | Timing |
| --- | --- | --- | --- |
| Mid-run notices were excluded by the written contracts. | The user changes a diagram while Codex works, but the model receives no notice. | Define debounced resource notices for committed human edits, target the current turn, skip agent echoes, and track accepted delivery. | Specify now; probe in phase 0; complete in phase 3. |
| Send-time references could freeze queued requests to old state. | "Build this" waits in a queue while the user changes the selected labels. | Keep the original reference for history; resolve stable IDs and build fresh board context at dispatch. Current reads are the default. | Specify now; implement with queue/context behavior. |
| Artifact attachment had no agent publication path. | Codex creates an output file but cannot obtain the artifact ID needed to attach it. | Add publish_artifact using the existing managed-file service, then attach the returned ID. | Define now; build in phase 4. |
| Native editor reconciliation and undo were assumed rather than proved. | An agent annotation arrives during a drag and overwrites it, echoes as a human edit, or breaks Ctrl-Z. | Test that exact race in the first editor slice. Begin with proven text/basic-shape writes; expand bindings and other operations as they pass. | Phase 0 before settling the editor adapter. |
| The first useful experience was gated behind excess infrastructure. | We build a headless renderer and all lifecycle schemas before trying the shared drawing loop. | Capture through the connected browser first, keep the runnable spike, save/reopen it next, and introduce models with their features. | Scope correction now. |

See [architecture](architecture.md#canvas-awareness), [contracts](contracts.md#canvas-references-and-context), and [phases](roadmap.md) for the revised decisions.

## What remains to prove

- The pinned Codex runtime can deliver a labeled canvas notice into an active turn at a supported boundary. Steering acceptance does not promise instant model attention or immediate redirection of running commands.
- Excalidraw can reconcile incoming agent operations with pending user edits and the selected undo strategy for the supported object subset.
- Region images exported from committed snapshots reach the model with correct bounds and source-image bytes.

These are small, executable integration experiments. If live notices fail, retain a visibly limited early slice and revisit the runtime route before claiming live collaboration. Do not silently describe next-turn context as live delivery.

## Keep the useful foundations

Retain one authoritative saved board, atomic revision-checked edits, durable image/output bytes, native runtime permissions, and undo that preserves later edits. Avoid duplicating Codex's execution loop or independently reconstructing its conversation history.

Defer independent background rendering, full historical timelines, automated file cleanup, provider generalization, multiplayer, and hosted operations until useful. The data model list describes responsibilities; it is not a requirement for a database table per row.

## First practical test

Draw two labeled boxes and ask Codex to inspect them. While it works, move a box and change a label. Confirm a batched resource notice reaches the active turn, the agent reads the latest state, and an editable annotation appears without erasing the human changes. Undo the annotation, then reopen and verify the saved board and source image remain intact.

Run the basic draw/ask/annotation loop first; add this concurrency-and-notice test as those capabilities land.

## Implementation review results

The local application now exists. Reviews during implementation produced regression checks and fixes for:

- Cross-session request-ID collisions, concurrent artifact publication, and retries after a lost mutation response.
- Image aspect ratio and editable arrow geometry, native stacking order, and human undo restoring a saved tombstone.
- Duplicate mutation notifications and human undo missing from active-turn awareness.
- Shared references between Excalidraw's mutable elements and canonical saved state, plus agent edits arriving during a pointer gesture.
- Native advertised approval decisions, uncertain notice delivery, queued-message context, and completion arriving before a turn-start acknowledgment.

The browser suite uses a test-only runtime to exercise the actual editor, capture path, application service, and store. The production application uses CodexRuntime. Live CLI initialization and thread creation succeeded, while inherited credentials prevented actual model inference. [Implementation evidence](implementation.md#runtime-status) records that remaining check without substituting fixture behavior for a real Codex run.
