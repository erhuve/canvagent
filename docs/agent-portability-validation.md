# Agent portability validation

Validated on macOS Apple Silicon, 26 October 2026. The changes follow the [Zed source review](zed-research.md); setup and operational boundaries are documented in [the agent guide](agents.md) and [context and review guide](context-and-review.md).

| Check | Result |
| --- | --- |
| TypeScript and production browser build | Passed |
| Unit/integration suite | 225 passed; 1 platform skip for an invalid UTF-8 filename unsupported by this filesystem. After the final diff truncation-notice fix, all 22 focused review/queue checks passed |
| Browser suite in installed Google Chrome | All 98 passed in the full run; all 23 chat/context/editor/review checks passed again after message admission fixes |
| Desktop prepared-resource suite | 5 passed, including serving/persistence, parent shutdown, real PTY, unavailable PTY recovery, and windowless macOS WebKit |
| Refreshed packaged sidecar | 4 sidecar checks passed after final configuration fixes |
| Final macOS application bundle | Release build and ad hoc signature verification passed; all 4 sidecar checks passed against the signed bundle’s actual Node binary and packaged resources |
| Installed Codex compatibility | Passed against Codex Desktop 0.163.0-alpha.10.2: same native thread/context, current five canvas tools, freehand schema and authenticated MCP tool call |
| Whitespace/diff checks | Passed |

The unit/integration suite uses real local HTTP servers, SQLite, subprocess protocol fixtures, and an actual local API-provider fixture. It covers agent identity migration, scoped readiness, safe history switching, config ownership, keys absent from state/database, endpoint credential isolation, native executable overrides, model defaults, ACP text/tool/permission/cancel/resume, HTTP and stdio MCP, provider image results, tool approval denial/acceptance/cancellation, and API authentication failure. Workspace checks cover revision conflicts, exclusive creation, symlink/traversal rejection, argument boundaries and command cancellation. Git checks cover staged/working/untracked diffs, unusual paths, nested workspace confinement, binary/truncated output and disabled external Git programs.

Browser checks cover the picker and manager, drafts/history, queued non-steering messages, contextual retry, credential updates/clearing, mobile/keyboard behavior, Git review and the existing chat/canvas/browser/files/editor/terminal/project/notification flows. The final full run had no failures or retries. Screenshots of the composer, manager, context/image previews, Git diff, and saved turn review were inspected.

Context checks cover frozen file/range, folder, conversation, canvas, and artifact snapshots; workspace image mentions; raster validation and integrity; project isolation; image-only sends and steering; queued image retention; unsupported image preflight; and native Codex, negotiated ACP, OpenAI-compatible, and Anthropic image payloads. Browser checks exercise `@mentions`, chip previews/removal, clipboard paste, drop, reload, send failures, late hydration/upload results, retained background drafts, selected-line save/attach, disk conflicts, and conversation switching during save.

Review checks cover immutable before/after diffs, observed canvas changes, incomplete scan coverage, unusual legal filenames, symlink/Git-internal rejection, binary limitations, corrupt snapshots, bounded diff notices, and guarded restoration of added/modified/deleted text. Deleted-file restoration preserves private/executable permission bits, with private access for legacy snapshots. Integration checks cover receipt deduplication while image capabilities connect, queued-message ordering during review completion, delayed start acknowledgments, late steering rejection, and shutdown during baseline capture.

No paid model inference is used by these checks. Claude Code, OpenCode, and Gemini executables were not installed in this environment. Their live authenticated inference, including understanding pasted images, and real paid API inference remain unverified. The native Codex compatibility check uses a local inference stub and a disposable archived conversation; it proves protocol/history/tool compatibility rather than model-driven canvas reasoning. Codex image inputs match the locally generated native app-server schema; ACP image input is advertised only after capability negotiation.

Follow-up verification: exercise an installed version of each external harness with working credentials, capture its negotiated capabilities, approve/deny a real operation, inspect an image on the board, stop a running turn, restart and resume where advertised. Exercise a real direct provider’s image and tool behavior with the intended model. API text currently arrives per completed response, and pasted keys intentionally expire with the server process; OS credential persistence and token streaming remain roadmap work.
