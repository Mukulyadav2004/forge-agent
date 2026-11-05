# Forge Agent

A VS Code extension that sends tasks to **local TrueForge**. TrueForge owns the model calls and agent loop. The extension supplies the sidebar and editor tools through MCP.

## Run

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

In the Extension Development Host, open a trusted local project, then run **Forge: Open Agent** from the Command Palette. The status-bar button and activity-bar icon open the same sidebar.

## Connect your first model

1. Start local TrueForge using the instructions in your TrueForge checkout. The extension does not start that server. Default URL: `http://127.0.0.1:8790`.
2. Configure a model in TrueForge. Keep provider keys there, not in this extension or Git.
3. In VS Code Settings, search **Forge Agent**. Set **Model** to the exact configured name, and **Base Url** to the local server URL.
4. Run **Forge: Copy Editor MCP Connection**. This copies a local URL and a temporary bearer token to your clipboard. In TrueForge Settings → Connectors, create a Streamable HTTP MCP connector named `forge-editor`, using that URL and Authorization header.
5. TrueForge must permit local outbound MCP connections. Its configuration needs `OUTBOUND_URL_ALLOWED_HOSTS=["localhost","127.0.0.1"]`; restart it after changing configuration. Keep its outbound URL protections enabled.
6. The MCP port and token change when the extension host restarts. Copy and update the connector after each restart. Clear your clipboard afterward.
7. Send a task. **Forge: New Task** creates a new conversation; subsequent messages in a task reuse its TrueForge session.

The current client targets an unauthenticated local TrueForge development server. Authenticated server support has not been added. Both processes must run on the same host; a container has a different localhost.

## What works in this milestone

- Sidebar messages and streamed assistant text, visible session/event status, errors, Cancel, and New Task.
- TrueForge tool approval events with approve/deny resumed as a new turn in the same session.
- **Forge: Edit Selection** (`Cmd+Option+F` on Mac): select code, provide an instruction, send the selection and its location.
- Authenticated loopback MCP tools: `list_files`, bounded `read_file`, and `propose_edit`.
- `propose_edit` snapshots both sides in memory and opens a read-only VS Code diff. It does not apply or save. Close the diff to discard it.
- Workspace trust checks, realpath containment for file reads, basic secret-path exclusion, and literal rendering of model/user text in the sidebar.

**Not implemented yet:** apply/accept/reject hunks, undo, command execution, code search/symbol tools, context ledger, automatic model fallback, persistent sessions or conversation history, and scout subagents. Basic secret-path exclusion is not a complete secret detector. This is a development milestone, not a contest-ready submission.

## Verification

```sh
pnpm run check
pnpm run test:integration
pnpm run test:smoke
# All checks:
pnpm run test
```

The integration test uses a local fake TrueForge HTTP server: it verifies the installed SDK's request/event handling, session reuse, approval input, cancellation request, and failed authentication. It does not call a model.

The smoke test launches an isolated VS Code profile and project. It checks real sidebar interaction, draft preservation, literal text rendering, empty input, missing-model errors, and the actual MCP bridge. Output is under `out-test/`. Tests need the `code` CLI and installed VS Code.

The build bundles TrueForge's ESM exports into the extension's CommonJS entry because the pinned SDK's published CommonJS entry fails when loaded directly. Do not replace the build with plain `tsc` emission.

## Read the code in this order

1. `src/extension.ts`: commands and extension startup.
2. `src/webview/main.ts` and `src/shared/messages.ts`: sidebar ↔ extension communication.
3. `src/sidebar/AgentViewProvider.ts`: conversation, approvals, and state.
4. `src/agent/ForgeSession.ts`: the TrueForge SDK boundary and agent definition.
5. `src/tools/EditorBridge.ts`: MCP, workspace access, proposed diffs.
6. `docs/NOV-4-5-HANDOFF.md`: remaining real-world checks.

No Cline source code has been copied into this implementation.
