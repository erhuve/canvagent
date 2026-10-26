# Local implementation

Canvagent now includes a React application, an embedded Excalidraw editor, a local Node.js service, SQLite persistence, and a Codex app-server adapter. The [architecture](architecture.md), [contracts](contracts.md), and [roadmap](roadmap.md) describe the intended design and release gates. This page describes the current code and setup.

The Tauri desktop shell adds a native workspace picker, remembered workspace, menus, a bundled Node 24 runtime, and coordinated shutdown. The macOS Apple Silicon bundle has been built and opened successfully, including a live connection to Codex CLI **0.163.0-alpha.10.2**. The existing browser interface remains available. See the [desktop instructions](../README.md#desktop-app-tauri) for build commands, data locations, and platform limits.

## Runtime status

Use Node.js 24 or newer. The original adapter verification targeted CLI **0.159.2**, including experimental dynamic tools over the local app-server stdio protocol. That initial smoke check recorded the following:

| Check | Evidence |
| --- | --- |
| Initialize, account read, and model catalog | The actual app-server returned responses. |
| Thread creation with canvas dynamic-tool definitions | The actual app-server accepted `thread/start`. |
| Turn submission | The actual app-server accepted `turn/start`; model inference then failed authentication. |
| Model-driven canvas tool calls, image understanding, steering, and resumed inference | Still require live verification with working inference. Protocol and application tests exercise these contracts using controlled runtimes. |

That initial model request returned HTTP 401 because its inherited ChatGPT login could not refresh its access token. Later desktop use connected successfully with CLI **0.163.0-alpha.10.2**. The current tool-refresh compatibility check against that CLI verifies the same persisted native thread and user context, discovery of all five current canvas tools including freehand drawing, and authenticated MCP tool calls. It uses a local inference stub rather than a model request. The UI displays the connected version, authentication state, and available models; use the standard `codex login` flow when authentication needs renewal.

Install [Codex CLI](https://developers.openai.com/codex/cli/) on `PATH` and run `codex login` using its normal authentication flow. Canvagent starts `codex app-server` and inherits that configuration. It does not ask you to copy credential files into the application.

## Starting the application

From the Canvagent checkout:

```sh
npm ci
npm run build
npm start -- --workspace /absolute/path/to/project
```

Open `http://127.0.0.1:4317`; Canvagent connects to Codex automatically once the local workspace connection opens. This checks the existing login and model catalog without opening a thread or replaying a turn. A failed attempt or required sign-in leaves **Connect Codex** available for manual retry; WebSocket reconnects do not start a retry loop. The workspace must already exist. These options select a different state directory or port:

```sh
npm start -- --workspace /absolute/path/to/project --data-dir /absolute/path/to/data --port 4317
```

| Setting | Command-line option | Environment variable | Default |
| --- | --- | --- | --- |
| Project directory | `--workspace` | `CANVAGENT_WORKSPACE` | Current working directory |
| Saved data | `--data-dir` | `CANVAGENT_DATA_DIR` | `~/.local/share/canvagent/<workspace-hash>` |
| Backend port | `--port` | `CANVAGENT_PORT` | `4317` |

Command-line options take precedence over environment variables. The workspace hash uses the absolute workspace path. Startup prints both the project path and exact data location. The backend binds to `127.0.0.1`.

For development:

```sh
CANVAGENT_WORKSPACE=/absolute/path/to/project CANVAGENT_DATA_DIR=/absolute/path/to/dev-data npm run dev
```

Open `http://127.0.0.1:5173`. Vite serves the interface and proxies requests to the backend on port 4317. The default development proxy assumes that backend port.

## Implemented behavior

Chat uses assistant-ui's React primitives and external-store runtime for streamed replies, the composer, scrolling, and conversation navigation. The local service still owns messages and Codex thread bindings. Tool activity, model selection, native approval controls, and active-turn interruption use the existing backend. Explicit messages sent while the agent works are steered into that turn when possible or visibly queued. Uncertain submissions are not automatically resent.

Computer Use permission requests arrive as MCP form elicitations. Empty forms offer **Approve once**, **Deny**, and **Cancel request**; accepted requests send an empty object as form content. Requests requiring form inputs or a verification flow currently explain that the flow is unsupported and offer denial or cancellation. They are never automatically accepted.

The canvas is available throughout a session. Each user turn supplies a bounded overview and selection. Committed human edits during a running turn are batched into `canvas_changed` notices and delivered through steering to the existing turn. The activity feed records accepted notices or unavailable delivery. A notice does not start another task, and agent annotations do not trigger a notice loop.

The agent receives these canvas tools through an authenticated local MCP connection:

| Tool | Behavior |
| --- | --- |
| `read_canvas` | Read committed objects, text, coordinates, IDs, and per-object service revisions. |
| `capture_region` | Render a committed snapshot as PNG using the connected editing browser. |
| `apply_canvas_ops` | Draw and edit arbitrary native freehand strokes, custom line/arrow paths, shapes and text, with revision checks and retry receipts. |
| `publish_artifact` | Copy a specified workspace file into managed storage and record its provenance. |
| `attach_artifact` | Place a retained image preview or labeled download link on the board. |

Keep the canvas browser open for visual inspection. Capture reports an error when a browser is unavailable; it does not substitute an invented screenshot. Object reads and ordinary workspace work can continue independently.

Freehand drawing uses `shape: "freedraw"` and a sequence of `[dx, dy]` offsets from `x, y`. Custom `line` and `arrow` elements also accept points; repeating the first point closes a line outline for filling. Geometry is calculated from the points, including negative offsets, so omit width and height when supplying points. Strokes support up to 4096 points, optional pressure samples matching the point count, pen thickness, colours, fills, opacity, roughness, rotation and native grouping. Pressure is simulated when samples are omitted. A drawing can contain any collection of strokes; the product contains no drawing templates or prescribed motifs. The agent can inspect a capture and revise individual strokes. Point replacement and resizing preserve native geometry; stale edits and undo use the existing revision guards.

When sending a message in an existing conversation, the adapter resumes the original native Codex thread with the current local MCP endpoint and verifies the tool catalogue before starting inference. Codex retains its complete native history, including context not present in Canvagent's UI messages. No transcript replay, summary, replacement thread or migration of saved history is involved. Older threads may still contain their persisted native tool definitions; developer instructions prefer the current MCP tools. New threads use the same refreshable connection. If discovery fails, the application retains the original thread binding and reports an error instead of starting a replacement conversation.

The endpoint binds to the current loopback service port and uses an ephemeral bearer credential distinct from the browser cookie. Discovery is scoped to a saved Canvagent conversation; tool calls also require that conversation's active native thread and turn. Queued calls are checked again before execution and retain their originating session attribution. This connection is configured only for this app's runtime and does not write the user's global Codex configuration.

Captures are capped at 2048 pixels along their longest edge. Close-ups exclude unrelated distant objects while retaining native parent frames for clipping. The intermediate render is also bounded; a single oversized intersecting element or frame can still reduce close-up detail.

The service owns committed board state. Human and agent mutations check affected-object revisions, and a conflicting batch leaves the scene unchanged. Native editor fields remain available for later editing. Undo of an agent mutation also checks for subsequent changes before restoring affected objects.

## Persistence and artifacts

One board belongs to the configured workspace/data directory and is shared by its conversations. The data directory contains:

- `canvagent.sqlite`: board state, object revisions, application sessions, mutation history, and retry receipts.
- `assets/`: retained bytes for imported and attached canvas images.
- `artifacts/`: retained published output files.

Published records include the original filename, title, media type, byte size, SHA-256 digest, session attribution, and publication time. Downloads verify the retained digest. Source-image bytes and published-output bytes are stored separately from references in the scene. Changing or deleting a workspace source after publication does not change the published copy.

Publication is explicit. The agent must call `publish_artifact` for a file inside the workspace, then use the returned artifact ID with `attach_artifact`. Ordinary workspace files are not automatically copied or exposed as artifacts. Raster attachments preserve image proportions; other published files appear as labeled download links.

The conversation file section uses a native disclosure element, initially collapsed with a file count. Its download list is bounded to 250 pixels and scrolls independently. Artifact updates preserve expansion, while changing conversations resets it to collapsed.

Browser export uses Excalidraw's native scene and image export features. Linked artifact bytes remain in Canvagent's managed storage; a scene export does not package all published files or conversation state. Keep the data directory when transferring or backing up that work.

To reopen, use the same workspace and saved-data directory. To back up, stop Canvagent and copy that entire directory. Codex owns its native conversation history and authentication separately; an application-data backup does not include those runtime files.

## Checks and limits

```sh
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run test:codex-tools
```

Build runs TypeScript checking and creates the browser bundle. The automated tests exercise persistence, revision conflicts, retry recovery, artifact bytes, application orchestration, tool upgrades, MCP credentials and active-turn scoping, and the runtime adapter using test subprocesses. Browser tests use a test-only provider connected through the real local MCP transport. Canvas checks draw and move saved shapes, capture real browser pixels, receive annotations, send live notices, reload, and safely undo agent edits while preserving human work. They also hold a pointer gesture open while an agent edit arrives, compare close-up capture pixels before and after adding a distant object, and verify that arbitrary freehand strokes render, move together as a native group, export as editable strokes, and survive reload. Chat checks cover streamed Markdown, steering, interruption, saved conversation switching, failed-draft recovery, command and Computer Use approvals, and mobile navigation. Build before running these tests; Linux installations may need `npx playwright install --with-deps chromium`.

The automated suites do not require provider authentication or model calls. GitHub CI runs the build and both suites. The separate `test:codex-tools` smoke check requires an installed Codex CLI and verifies native history retention and refreshed tool discovery against a local inference stub; it does not make paid model calls. Node 24's built-in SQLite module may emit its standard experimental warning.

The current application supports one editing browser, multiple projects in the sidebar, one board per project, and parallel conversations with one active agent turn per conversation. A single workspace host retains each project's independent database, files, event feed, and runtimes while the user navigates between projects. Pending canvas edits save before switching; drafts persist in the same browser window. Each conversation owns its runtime, dispatch queue, approvals, interruption, canvas MCP credentials, and live resource notices. Visual captures require that project's canvas to be open. Human multiplayer, additional providers, external MCP access, hosted operation, and portable project export remain follow-up work.

Sidebar and chat/workspace dividers support pointer dragging, keyboard adjustment, and double-click reset, with responsive minimum pane sizes. Authenticated `/api/layout/settings` stores sidebar width and chat ratio in the project's SQLite database, so preferences survive restarts and changed local ports.

The right workspace dock also contains Browser and Files. Desktop Browser uses a child webview with navigation/history controls and no desktop command capabilities; browser-hosted Canvagent uses an iframe. Files lists the current workspace, previews raster images, and opens multiple UTF-8 text buffers. Saves check a SHA-256 revision before atomic replacement and preserve file mode. Existing edits remain when a newer disk version conflicts. Unsaved buffers guard project switching and desktop quit. Binary and oversized text files remain downloadable. Directory and file operations reject paths outside the workspace, symlink escapes, and Git internals.

Browser annotations draw temporary pen, highlighter, and rectangle marks in selected colors, with undo and clear controls. Done or Escape exits drawing mode; switching away from Browser also stops drawing. A shared canvas-overlay renderer runs in the iframe wrapper or native page, keeps marks in memory, and clears them on page loads. Native annotation commands remain restricted to the main app webview.

Monaco provides editing, language workers, find/replace, multi-cursor operations, undo/redo, formatting, and the editor command palette. Each open file has its own model and saved view state. All editor workers ship locally with the application. Quick Open and project search use authenticated project routes, worker-based recursive discovery, bounded results, cancellation, and a search deadline; search positions use Monaco's one-based UTF-16 line/column convention. macOS Go menu commands forward the normal file-search shortcuts to the main interface while the embedded browser owns keyboard focus.

Vim bindings use monaco-vim and are enabled by default, including Normal/Insert mode, motions, undo, and `:w` through the existing revision-checked save route. The file toolbar toggle is persisted in the project's SQLite store through `/api/editor/settings`, so it survives app restarts and a changed local port. ⌘/ or Ctrl+/ toggles JSX-aware comments in TSX/JSX through the TypeScript worker, including with Vim enabled; saves wait for pending comment edits.

The terminal drawer uses xterm.js and node-pty for interactive project shells. **Terminal** and **Ctrl+backtick** toggle the drawer; tabs, resizing, and scrollback remain available while chat and the selected workspace panel stay mounted. Terminal routes and WebSockets use the project's existing authentication and origin checks. Shells continue while hidden or while another project is selected and end when their terminal tab or Canvagent closes.
