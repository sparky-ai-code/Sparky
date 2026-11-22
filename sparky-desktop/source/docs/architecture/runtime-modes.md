# Runtime modes

Sparky has a global access mode switch in the chat toolbar. The selected access mode is stored with the thread session and passed to the native Rust agent at the start of every turn, including turns served by a prewarmed persistent process.

| Access mode | File edits | Shell commands | Other side-effecting tools (including external MCP tools) |
| --- | --- | --- | --- |
| **Full access** (default) | Execute | Execute | Execute |
| **Supervised** (`approval-required`) | Ask before execution | Ask before execution | Ask before execution |
| **Auto-accept edits** (`auto-accept-edits`) | Execute built-in `write` / `edit` tools | Ask before execution | Ask before execution |

Read-only built-in tools (such as `read`, `ls`, `grep`, `find`, and `web_search`) do not prompt. Unrecognized tools fail closed in restricted modes, rather than being silently treated as harmless. The separate **Chat / Plan** interaction toggle controls which tools can be proposed by the model; Plan mode remains read-only and is not a substitute for the access mode.

## Native approval flow

1. The agent checks the access policy **before** executing a tool. If approval is needed, it sends an `approval.requested` frame to the desktop over the persistent process stream, including the tool name, call ID, and arguments.
2. The desktop publishes a canonical `request.opened` event. The existing chat approval card pauses the tool while the user reviews the command or file/tool operation.
3. An explicit **Approve**, **Approve for session**, or **Deny** action sends an `approval.respond` frame to the native CLI and closes the card with `request.resolved`.
4. The native agent resumes only when the approval response is accepted. Denial, a missing response channel, or a disconnected host never executes the tool.

In **Supervised**, accepting one request permits only that request; accepting for the session permits that named tool for the remaining process session, and switching access modes clears such grants. In **Auto-accept edits**, only built-in file editing is automatically approved; a shell command that edits files is still a command and still requires approval.

A locally rebuilt native `sparky` CLI binary is required for the new handshake: older binaries do not understand `--runtime-mode` or `approval.respond`.
