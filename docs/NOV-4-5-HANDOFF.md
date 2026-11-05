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

## Checks that still need your configuration

No real model or running TrueForge server was configured during this sprint. The following are **not verified**, even if local automated tests pass:

- Local TrueForge reaches the extension's MCP connector.
- Your chosen model produces streaming output and valid tool calls.
- Real approval event → decision → new-turn continuation.
- Cancel during a real model request or MCP call.
- A bad model key gives a useful error with your provider.
- Flask Tasks A/B/C and model selection, provider fallback, latency and cost.

Start with: “List the files in this workspace, read example.txt, then propose replacing one sentence.” Approve the preview request. Confirm the diff opens and the file stays unchanged. Then send a follow-up to confirm the same session ID. Try Cancel on a longer request and start a New Task afterward.

## Next implementation milestone

1. Preserve proposals as structured records with base content/version and clear IDs. Add review controls with conflict detection before any write.
2. Add per-hunk accept/reject and transaction snapshots for multi-file undo. Test dirty editors and edits made while a proposal is pending.
3. Add search and symbol discovery with explicit result limits, then the context ledger.
4. Add command approval and cancellation semantics separately; a shell command can write files even when editor tools do not.
5. Run the actual Flask tasks repeatedly using the configured model before investing in UI polish.

Current approval UI is intentionally minimal and does not render tool arguments. Before adding any tool that writes or executes commands, display its exact arguments and consequences for review. Current model text displays as plain text, not rich Markdown.

## Your two-person division

One person owns `src/agent` and real TrueForge/model/MCP integration. The other owns `src/sidebar`, `src/webview`, and proposal review. Agree on shared message contracts before parallel edits. Complete live integration first; postpone fallback and scout work until basic edits are reliable.

## Research anchors

- https://trueforge.dev/api/use-agent
- https://trueforge.dev/create-agent/overview
- Local TrueForge checkout and installed SDK declarations were inspected for the integration contracts.

The executable agent specification currently lives in `src/agent/ForgeSession.ts`; `/agent/README.md` points to it so there is only one definition to change.
