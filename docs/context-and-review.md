# Chat context, images, and turn review

Attach context with `@` in the composer or **Attach context**. Search for project files, folders, saved conversations, canvas objects, and published artifacts. Choosing an item creates a removable chip. Expand a chip to inspect the exact snapshot that will be sent. Text in the message is editable independently of its context chips; removing a chip removes that resource from the explicit context.

In Files, **Attach to chat** attaches the current file or selected lines. The editor also offers **Add selection to chat** in its context menu and through Cmd/Ctrl+Shift+A. Pending edits are saved before attaching; a disk conflict preserves the editor draft and prevents attachment. **Ask about selection** on the canvas adds an explicit snapshot of the selected objects. The current board overview continues to accompany each turn automatically.

Paste an image into the chat composer, drop images over it, or use **Image** to choose files. PNG, JPEG, WebP, and GIF are supported. You can send an image without text. Up to six images may be attached to one message, each up to 10 MiB, with a combined image limit of 20 MiB; all context is limited to twelve attachments and 100,000 characters of text. Uploads and invalid attachments block sending until they finish or are removed. Agents without negotiated image input explain that limitation and preserve the draft.

Attachments are immutable snapshots captured when added. Editing a source file later does not change the context shown on an already attached chip or saved message. Uploaded image bytes are retained in the project's saved-data directory; chat state and browser storage contain image references, never the image's base64 data. Removing a draft chip does not delete an image already used by another message. Draft attachment references survive reloads and conversation/project switching in the same window. The saved transcript shows the original attachments after sending.

Codex receives native image inputs, ACP receives image content blocks when the agent advertises support, and direct OpenAI-compatible/Anthropic providers receive their respective image formats. Active Codex turns accept image updates; other agents queue the complete text and attachment set for their next turn. API reconnects hydrate saved images alongside their visible transcript without replaying completed tools.

## Review changes from the conversation

Each new turn records a bounded workspace snapshot before work starts and after it finishes, fails, or is stopped. **Review changes** beneath the conversation opens its saved file diffs and affected canvas objects. You can choose an earlier recorded turn. The comparison remains unchanged when files are edited again later.

The review describes changes **observed during the turn**. Another editor, terminal, or parallel agent may have contributed in a shared checkout. The snapshots do not prove which process authored each change. Worktree isolation remains the next step for stronger task separation.

**Restore file before this turn** first shows a concrete confirmation. A restore applies only when the current file still matches the turn's ending snapshot; later human edits are preserved with a conflict message. Added files are removed, deleted text files are recreated with their saved access/executable permissions when their original parent remains available, and modified text files regain their saved contents. Binary restoration is unavailable. Restoring while another agent is working is blocked. The canvas action reveals affected objects; the existing revision-guarded **Undo agent edit** remains the canvas restoration control.

Snapshot work has file, byte, discovery, and time limits and excludes generated/dependency folders and Git internals. Reviews display a notice when coverage is incomplete. Omitted files are never treated as proven additions/deletions. Full current Git state is still available in the separate **Changes** panel. Earlier conversations and interrupted app sessions can lack a turn snapshot; the UI says when one is unavailable.
