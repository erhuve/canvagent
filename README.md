<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/mark-dark.svg">
  <img src="public/brand/mark.svg" alt="Canvagent logo: an open C with a cursor nestled inside" width="96" height="96">
</picture>

# canvagent

Canvagent is a local Codex harness with a persistent Excalidraw canvas shared by you and your agent. Chat about a project, sketch an idea, drop in a screenshot, and let Codex inspect and annotate the same board while it works.

![Canvagent desktop workspace with Codex chat, a shared design canvas, and an integrated terminal](docs/images/canvagent-workspace.png)

*Plan, build, and review with Codex beside a canvas you can both edit.*

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

## Desktop app (Tauri)

The desktop app opens with a native workspace folder picker and runs the same chat, Excalidraw editor, and Codex backend in a Tauri window. It bundles a standalone Node 24 runtime; installed-app users still need Codex CLI and its normal login, but do not need to install Node separately.

To build or develop it, install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) and Rust, then run:

```sh
npm ci
npm run desktop:dev
```

Build a macOS application bundle:

```sh
npm run desktop:build -- --bundles app
```

The result is `src-tauri/target/release/bundle/macos/Canvagent.app`, signed ad hoc for local use. Launch it, choose a project folder, and connect Codex. Use **Workspace → Open Workspace…** to change projects; pending canvas edits are saved first, and an active Codex turn asks for confirmation before stopping. Closing the window saves pending edits and shuts down the local service. The launcher remembers the last workspace for the next launch.

The build downloads the official Node archive and checks its SHA-256 against `scripts/node-runtime.json`. Downloaded runtimes, the optional project-local Rust toolchain, and generated desktop resources are ignored by Git. The desktop scripts detect the local toolchain under `.canvagent/toolchain` if one is installed there; otherwise they use your normal Rust installation.

Desktop data is stored in the OS application-data directory under `app.canvagent.desktop/workspaces/<workspace-hash>` (on macOS, under `~/Library/Application Support/`). An existing default CLI database under `~/.local/share/canvagent/<workspace-hash>` is reused when present. Custom browser `--data-dir` locations remain separate.

```sh
npm run desktop:check
npm run test:desktop
```

`desktop:check` builds resources and checks the Rust shell. The desktop tests use the bundled Node binary to verify serving, origin checks, WebSocket delivery, persistence, and parent-process shutdown without model calls. The macOS bundle is for local use; distribution to other Macs requires Apple signing and notarization. Windows and Linux builds need their native Tauri prerequisites and have not yet been validated.

## Use the shared canvas

- Draw or import an image, then ask Codex about it in chat. Select objects to focus the request.
- The agent can freehand draw arbitrary strokes and custom paths, with pen pressure, colour, thickness, fill, opacity and grouping. Drawings remain native editable Excalidraw elements. Revision checks protect newer edits, and the interface provides undo for agent changes.
- Committed canvas changes during a running turn send batched notices through Codex steering. Idle drawing does not start agent work. Notice delivery appears in the activity feed.
- Use ordinary chat, tool activity, approval controls, stop, conversation history, and model selection alongside the canvas.
- Ask the agent to publish generated files and attach them to the board. Raster images get previews; other outputs get download links with provenance. Workspace files are never published automatically.

One project board is shared across its saved conversations. You can switch conversations, create new ones, and run work in parallel. Each conversation has its own Codex runtime, approvals, stop control, and live canvas notices; the sidebar shows running conversations and those awaiting approval. The app supports one editing browser. Codex retains its execution loop, built-in tools, sandbox, authentication, and native conversation history.

The chat composer's toolbar has approval mode, Default/Plan mode, model, thinking level, and a Fast mode toggle. Toolbar choices save immediately for that conversation's next turn and are remembered as the project's defaults for new conversations, including after restarting the app. Existing conversations retain their own settings, and an active turn keeps its original settings. **More Codex settings** opens additional controls for approval policy and reviewer, sandbox access, networking and writable folders, web search, reasoning summaries, response verbosity, and extra instructions. In that dialog, **Save settings** applies only to the current conversation; **Save as defaults** changes all starting settings for new conversations. Available thinking levels and speed tiers come from Codex's model catalog, and Codex's managed requirements still apply. Additional native thread configuration can be supplied as JSON in the settings dialog; explicit controls take priority, and the shared canvas integration remains enabled. These controls do not edit your global Codex configuration.

Existing conversations receive the current canvas tools automatically when you send the next message after an app upgrade. Canvagent resumes the same native Codex thread and discovers the current tools through its authenticated local canvas connection. Your conversation context, chat history and project canvas stay in place. No new conversation or history summary is needed.

The chat interface uses [assistant-ui](https://github.com/assistant-ui/assistant-ui) for conversations, streamed messages, Markdown, and the composer. It connects to the existing local Codex backend; no Assistant Cloud account or additional model API key is needed. Excalidraw remains the shared canvas.

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

To check tool upgrades against an installed Codex CLI, run `npm run test:codex-tools` (or set `CANVAGENT_CODEX_BIN` to its executable). This creates and archives a disposable native conversation, uses a local inference stub, restarts the runtime, and verifies that its persisted context and thread ID survive while the latest drawing tools become available. No model inference is performed.

The automated checks use test runtimes and do not require a Codex login or paid model calls. The browser tests exercise real drawing, regional capture, live notices, concurrent edits, reload, and guarded undo. Build before running them; on Linux, Playwright may require `npx playwright install --with-deps chromium`. Node 24 may print its standard experimental warning for the built-in SQLite module.

## Brand assets

The editable logo source is [`public/brand/mark.svg`](public/brand/mark.svg). Run `npm run brand:build` to regenerate the light and dark assets, launcher artwork, and macOS, Windows, and PNG app icons. Rebuild the desktop app to apply a regenerated icon to its bundle.

## Project documents

- [Implementation and runtime status](docs/implementation.md)
- [Phases of work](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [Data models and contracts](docs/contracts.md)
- [Adversarial review](docs/adversarial-review.md)

External MCP clients, other agent providers, portable project export, human multiplayer, and hosted deployment remain follow-up work. Excalidraw is [MIT licensed](https://github.com/excalidraw/excalidraw/blob/master/LICENSE); agent usage follows Codex authentication and billing.
