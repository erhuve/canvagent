# Local implementation

Canvagent now includes a React application, an embedded Excalidraw editor, a local Node.js service, SQLite persistence, and a Codex app-server adapter. The [architecture](architecture.md), [contracts](contracts.md), and [roadmap](roadmap.md) describe the intended design and release gates. This page describes the current code and setup.

## Runtime status

Use Node.js 24 or newer. The Codex adapter targets CLI **0.159.2**, including experimental dynamic tools over the local app-server stdio protocol. A live smoke check verified the following with that CLI version:

| Check | Evidence |
| --- | --- |
| Initialize, account read, and model catalog | The actual app-server returned responses. |
| Thread creation with canvas dynamic-tool definitions | The actual app-server accepted `thread/start`. |
| Turn submission | The actual app-server accepted `turn/start`; model inference then failed authentication. |
| Model-driven canvas tool calls, image understanding, steering, and resumed inference | Still require live verification with working inference. Protocol and application tests exercise these contracts using controlled runtimes. |

The model request returned HTTP 401 because the inherited ChatGPT login could not refresh its access token and requested a fresh sign-in. Complete the standard `codex login` flow before local use; the verification environment needs a fresh login to finish those live checks. Successful account discovery alone did not establish working model authentication. The UI displays the connected version, authentication state, and available models. Compatibility with other CLI versions is not established.

Install [Codex CLI](https://developers.openai.com/codex/cli/) on `PATH` and run `codex login` using its normal authentication flow. Canvagent starts `codex app-server` and inherits that configuration. It does not ask you to copy credential files into the application.

## Starting the application

From the Canvagent checkout:

```sh
npm ci
npm run build
npm start -- --workspace /absolute/path/to/project
```

Open `http://127.0.0.1:4317`, choose **Connect Codex**, and send a message. The workspace must already exist. These options select a different state directory or port:

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

Chat includes streamed agent replies, tool activity, available-model selection, native approval controls, active-turn interruption, conversation history, and saved Codex thread bindings. Explicit messages sent while the agent works are steered into that turn when possible or visibly queued. Uncertain submissions are not automatically resent.

The canvas is available throughout a session. Each user turn supplies a bounded overview and selection. Committed human edits during a running turn are batched into `canvas_changed` notices and delivered through steering to the existing turn. The activity feed records accepted notices or unavailable delivery. A notice does not start another task, and agent annotations do not trigger a notice loop.

The agent receives these native canvas tools:

| Tool | Behavior |
| --- | --- |
| `read_canvas` | Read committed objects, text, coordinates, IDs, and per-object service revisions. |
| `capture_region` | Render a committed snapshot as PNG using the connected editing browser. |
| `apply_canvas_ops` | Create, update, or delete editable native shapes and text with revision checks and retry receipts. |
| `publish_artifact` | Copy a specified workspace file into managed storage and record its provenance. |
| `attach_artifact` | Place a retained image preview or labeled download link on the board. |

Keep the canvas browser open for visual inspection. Capture reports an error when a browser is unavailable; it does not substitute an invented screenshot. Object reads and ordinary workspace work can continue independently.

The service owns committed board state. Human and agent mutations check affected-object revisions, and a conflicting batch leaves the scene unchanged. Native editor fields remain available for later editing. Undo of an agent mutation also checks for subsequent changes before restoring affected objects.

## Persistence and artifacts

One board belongs to the configured workspace/data directory and is shared by its conversations. The data directory contains:

- `canvagent.sqlite`: board state, object revisions, application sessions, mutation history, and retry receipts.
- `assets/`: retained bytes for imported and attached canvas images.
- `artifacts/`: retained published output files.

Published records include the original filename, title, media type, byte size, SHA-256 digest, session attribution, and publication time. Downloads verify the retained digest. Source-image bytes and published-output bytes are stored separately from references in the scene. Changing or deleting a workspace source after publication does not change the published copy.

Publication is explicit. The agent must call `publish_artifact` for a file inside the workspace, then use the returned artifact ID with `attach_artifact`. Ordinary workspace files are not automatically copied or exposed as artifacts. Raster attachments preserve image proportions; other published files appear as labeled download links.

Browser export uses Excalidraw's native scene and image export features. Linked artifact bytes remain in Canvagent's managed storage; a scene export does not package all published files or conversation state. Keep the data directory when transferring or backing up that work.

To reopen, use the same workspace and saved-data directory. To back up, stop Canvagent and copy that entire directory. Codex owns its native conversation history and authentication separately; an application-data backup does not include those runtime files.

## Checks and limits

```sh
npm run build
npm test
```

Build runs TypeScript checking and creates the browser bundle. Automated tests exercise persistence, revision conflicts, retry recovery, artifact bytes, and the runtime adapter using test subprocesses. These checks do not require provider authentication or model calls. Real-runtime verification remains a separate release gate. Node 24's built-in SQLite module may emit its standard experimental warning.

The current application supports one editing browser, one project board, and one active agent turn at a time. Human multiplayer, additional providers, external MCP access, hosted operation, and portable project export remain follow-up work.
