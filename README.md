# canvagent

Canvagent is a local Codex harness with a persistent Excalidraw canvas shared by you and your agent. Chat about a project, sketch an idea, drop in a screenshot, and let Codex inspect and annotate the same board while it works.

**Status:** the local application is implemented. Codex CLI **0.159.2** accepted live initialization, thread creation, and turn submission; expired login credentials prevented inference. [Runtime evidence and remaining checks](docs/implementation.md#runtime-status) distinguish verified protocol behavior from model-driven canvas behavior still to verify.

## Run locally

Use **Node.js 24 or newer** and install [Codex CLI](https://developers.openai.com/codex/cli/) on your `PATH`. Sign in through Codex's normal login flow:

```sh
codex login
npm ci
npm run build
npm start -- --workspace /absolute/path/to/your/project
```

Open **http://127.0.0.1:4317** and choose **Connect Codex**. Canvagent uses your existing Codex authentication and available models. Keep the browser open when asking the agent to inspect drawings or screenshots: canvas captures render in that browser.

To choose the saved-data directory or local port:

```sh
npm start -- --workspace /absolute/path/to/project --data-dir /absolute/path/to/saved-data --port 4317
```

Run these commands from the Canvagent checkout. The workspace defaults to the current directory when omitted. The service listens on `127.0.0.1`.

## Use the shared canvas

- Draw or import an image, then ask Codex about it in chat. Select objects to focus the request.
- Agent annotations are editable Excalidraw shapes and text. Revision checks protect newer edits, and the interface provides undo for agent changes.
- Committed canvas changes during a running turn send batched notices through Codex steering. Idle drawing does not start agent work. Notice delivery appears in the activity feed.
- Use ordinary chat, tool activity, approval controls, stop, conversation history, and model selection alongside the canvas.
- Ask the agent to publish generated files and attach them to the board. Raster images get previews; other outputs get download links with provenance. Workspace files are never published automatically.

One project board is shared across its saved conversations. The current app supports one editing browser and one active agent turn at a time. Codex retains its execution loop, built-in tools, sandbox, authentication, and native conversation history.

## Saved work

The default data location is `~/.local/share/canvagent/<workspace-hash>`, where the hash identifies the absolute workspace path. Startup prints the exact directory. It contains the SQLite database, imported image bytes, and published artifact bytes; editing or removing an original source file does not replace a retained published copy.

Use the same workspace and data directory to reopen saved work. To back it up, stop Canvagent and copy the entire data directory. Codex maintains its own native threads and credentials separately.

## Development

```sh
npm ci
CANVAGENT_WORKSPACE=/absolute/path/to/project CANVAGENT_DATA_DIR=/absolute/path/to/dev-data npm run dev
```

Open **http://127.0.0.1:5173** for the Vite development interface. The local backend uses port 4317. For a single-server run, build and use `npm start` instead.

```sh
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

The automated checks use test runtimes and do not require a Codex login or paid model calls. The browser tests exercise real drawing, regional capture, live notices, concurrent edits, reload, and guarded undo. Build before running them; on Linux, Playwright may require `npx playwright install --with-deps chromium`. Node 24 may print its standard experimental warning for the built-in SQLite module.

## Project documents

- [Implementation and runtime status](docs/implementation.md)
- [Phases of work](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [Data models and contracts](docs/contracts.md)
- [Adversarial review](docs/adversarial-review.md)

External MCP clients, other agent providers, portable project export, human multiplayer, and hosted deployment remain follow-up work. Excalidraw is [MIT licensed](https://github.com/excalidraw/excalidraw/blob/master/LICENSE); agent usage follows Codex authentication and billing.
