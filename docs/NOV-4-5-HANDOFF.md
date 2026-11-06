# November 4–5 handoff

## What was built

The local echo panel became a TrueForge client. SDK 0.183.0, MCP SDK 1.32.2, Zod 4.6.7, and esbuild 0.28.2 are pinned. The extension has no provider client and no independent model/tool agent loop.

```text
Selected code or sidebar message
  → extension host
  → TrueForge SDK → local TrueForge → configured model
  ← streamed events / approval required
  → approval decision as a new turn

TrueForge → configured MCP connector → extension's loopback HTTP server
  → list_files / read_file / propose_edit
  → in-memory proposed diff in VS Code
```

A task uses one session until New Task. Conversations and proposals are in memory and disappear on extension restart. The tool server permits only local requests carrying the generated bearer token and rejects browser Origin headers. Model tools have no file-write or shell-execution capability in this milestone.

The extension now registers the active port and authentication header automatically before session creation. Each extension host has a separate connector name (`forge-editor-<window-id>`). Reopening a folder therefore creates a current editor connection on the next task instead of reusing an obsolete port from manual setup. Existing development windows need one reload to pick up this fix.

## November 6 verification update

The running local server now exposes `google-gemini/gemini-3-1-flash-lite`. A real greeting through the extension's SDK client and TrueForge completed successfully. TrueForge also discovered all three editor tools using header authentication. `pnpm run test` passed, including regression coverage for retrying corrected model settings after a rejected session creation and selecting a model from the server's list.

The extension now includes **Select model** / **Forge: Select Model**. Fully qualified names must match the configured provider, and failed session creation no longer retains stale settings. Existing tasks still require **Forge: New Task** after manually changing the model.

## Remaining live checks

The following are still **not verified** with the real model:

- The model chooses and executes the appropriate editor tools for a coding task.
- Real approval event → decision → new-turn continuation.
- Cancel during a real model request or MCP call.
- A bad model key gives a useful error with your provider.
- Flask Tasks A/B/C and model selection, provider fallback, latency and cost.

Start with: “List the files in this workspace, read example.txt, then propose replacing one sentence.” Approve the preview request. Confirm the diff opens and the file stays unchanged. Then send a follow-up to confirm the same session ID. Try Cancel on a longer request and start a New Task afterward.

## Next implementation milestone

1. Preserve proposals as structured records with base content/version and clear IDs. Add review controls with conflict detection before any write.
2. Add per-hunk accept/reject and transaction snapshots for multi-file undo. Test dirty editors and edits made while a proposal is pending.
3. Add search and symbol discovery with explicit result limits. The current evidence list and bounded architecture context still need context-selection reasons and token accounting.
4. Add command approval and cancellation semantics separately; a shell command can write files even when editor tools do not.
5. Run the actual Flask tasks repeatedly using the configured model before investing in UI polish.

Current approval UI is intentionally minimal and does not render tool arguments. Before adding any tool that writes or executes commands, display its exact arguments and consequences for review. Model text now renders as sanitized Markdown with Mermaid and local source links. Unsupported OpenUI and other unimplemented harness interactions are disabled in the agent definition. See `QUALITY-NOV6.md` for the current analysis-quality limits.

## Your two-person division

One person owns `src/agent` and real TrueForge/model/MCP integration. The other owns `src/sidebar`, `src/webview`, and proposal review. Agree on shared message contracts before parallel edits. Complete live integration first; postpone fallback and scout work until basic edits are reliable.

## Research anchors

- https://trueforge.dev/api/use-agent
- https://trueforge.dev/create-agent/overview
- Local TrueForge checkout and installed SDK declarations were inspected for the integration contracts.

The executable agent specification currently lives in `src/agent/ForgeSession.ts`; `/agent/README.md` points to it so there is only one definition to change.
