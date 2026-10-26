# Bring your own agent

The composer’s agent picker includes Codex, Claude Code, OpenCode, and Gemini CLI. Each uses an executable already installed on the computer running Canvagent and that harness’s authentication. **Manage agents** lets you edit those commands or add any ACP v1 agent using an executable and an argument array. Authenticate through the harness before selecting it. No package is downloaded or installed automatically.

| Agent | Default executable and arguments | Connection |
| --- | --- | --- |
| Codex | `codex app-server` | Native Codex protocol, existing login/settings/history |
| Claude Code | `claude-agent-acp` | Claude Code ACP adapter, installed separately |
| OpenCode | `opencode acp` | ACP, OpenCode’s configured providers |
| Gemini CLI | `gemini --experimental-acp` | ACP, Gemini’s configured authentication |
| Custom harness | Your executable and JSON argument array | ACP v1 |
| API provider | Model ID, API base URL and credential | OpenAI-compatible Chat Completions or Anthropic Messages |

Agent selection is saved per conversation and remembered as the project’s default for new conversations. Choosing another agent after a conversation has messages starts a new conversation; the old native session stays bound to its original agent. Connection readiness, permissions, models, and errors belong to the active conversation. Existing saved conversations migrate to Codex. Configurations referenced by saved conversations cannot be removed, so native history can still resume.

## External harnesses

ACP forwards the shared canvas MCP server over negotiated HTTP or a bundled stdio bridge. It supports assistant text, tool activity, exact permission choices, cancellation, and native session loading when the harness advertises it. Models and permissions otherwise follow the harness’s configuration. Codex supports live steering and canvas notices; agents without steering accept messages queued for the next turn, with fresh canvas context at dispatch. ACP filesystem and terminal delegation are not advertised; harnesses use their own tools. Other CLIs and TUIs can run in the existing terminal; structured chat and shared tools require an ACP adapter.

## Direct model APIs

Add an **OpenAI compatible API** or **Anthropic API** agent. Supply an exact model ID and optionally an API base URL, including `/v1` where required. Defaults are `https://api.openai.com/v1` and `https://api.anthropic.com/v1`. OpenAI-compatible local servers may use HTTP on localhost without a key; remote endpoints require HTTPS. Responses-only APIs require a separate adapter and are not supported by the Chat Completions connection.

Reference a server environment variable for reusable credentials, or paste a key for the running server session. Pasted keys stay in memory and must be re-entered after restarting the service. They never enter the database, returned configuration, or browser storage. Custom endpoints need an explicit key or environment reference; default provider credentials are not implicitly forwarded to another endpoint. Changing the endpoint clears the pasted key. Environment mappings for harnesses also use variable **names**, not secret values.

The direct API agent has a bounded tool loop for canvas inspection/editing, artifacts, project file listing/reading/searching, revision-checked edits, new files, and executable commands. File writes, file creation, and every command require explicit approval. Commands run in the project folder with the local user’s authority, without a Canvagent filesystem sandbox, for up to 30 seconds; Stop cancels running commands. Native Codex sandbox controls apply to Codex only. New files require an existing parent directory; an approved command can create directories.

API readiness means configuration is available; authentication is validated on the first provider request. Provider responses currently appear when each API response completes; token streaming is follow-up work. API conversations rebuild context from the saved visible transcript after reconnect/restart; native tool history stays in memory and completed tools are never replayed automatically. Tool rounds are bounded to prevent an unending autonomous loop; send a follow-up to continue after the limit.

## Validation boundary

The adapters are verified with local ACP subprocesses and API HTTP fixtures, including permissions, tool loops, image results, cancellation, native resume boundaries, credentials, and canvas transports. Live authenticated Claude/OpenCode/Gemini inference and live paid API calls have not been verified in this environment. Only Codex is installed here. Record actual harness versions and live capabilities when that validation is performed. See the [source review and feature matrix](zed-research.md) and [delivery roadmap](roadmap.md).
