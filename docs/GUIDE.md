# Forge Agent: detailed guide

The [README](../README.md) is the short version. This page keeps the full setup notes, behaviour details and verification commands.

A VS Code extension that sends tasks to **local TrueForge**. TrueForge owns the model calls and agent loop. The extension supplies the sidebar and editor tools through MCP.

See [the project history](PROJECT-HISTORY.md) for planning decisions, problems and fixes, milestone evidence and remaining work through 10 November 2026.

## Starting point, upstream source and licence

**Repository starting point: from scratch.** This repository is not a Git-history fork of Cline. Its initial commit is `05ffce16d5d405027ca1662dd104c5ecfdf27a16` in [Mukulyadav2004/forge-agent](https://github.com/Mukulyadav2004/forge-agent). Selected Cline editor code was adapted later; the Cline source commit below is a reuse reference, not an ancestor of this repository.

- **Upstream repository:** [cline/cline](https://github.com/cline/cline).
- **Source checkout:** [Mukulyadav2004/myAiCodingAssistant](https://github.com/Mukulyadav2004/myAiCodingAssistant).
- **Exact source commit:** `7a7878cb52fc33967d8b464b3e3d899beac42d4d`.
- **Borrowed implementation:** `apps/vscode/src/hosts/vscode/VscodeEditPreview.ts`, adapted as [src/editor/ClineEditPreview.ts](../src/editor/ClineEditPreview.ts). It supplies virtual documents, the native VS Code diff preview, focus preservation and precise preview-tab cleanup. The focus-preservation scenario from `apps/vscode/src/hosts/vscode/VscodeEditPreview.test.ts` was also adapted in [test/edits/realEditor.ts](../test/edits/realEditor.ts).
- **Borrowed review rendering:** `DiffLine` and the old/new line-counter behavior from `apps/vscode/webview-ui/src/components/chat/DiffEditRow.tsx`, now in [src/webview/components/review/DiffLines.tsx](../src/webview/components/review/DiffLines.tsx) as part of the React sidebar port from Cline commit `eff43e19b267e171f597ab03733bfed25090f72d` (see THIRD_PARTY_NOTICES.md). It retains line gutters, change markers, indicator bars and changed-line colors; uses VS Code theme variables; preserves code indentation; and consumes computed hunks without Cline's controller or patch-parser dependencies.
- **Borrowed layout:** the grid/flex layout from `apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/ChatLayout.tsx` and content/footer separation in `apps/vscode/webview-ui/src/components/chat/ChatView.tsx`, at the same source commit, are adapted in [src/webview/components/chat/ChatView.tsx](../src/webview/components/chat/ChatView.tsx) and [src/webview/index.css](../src/webview/index.css): a compact header, a scrolling task area and a separate bottom composer. Forge's review toolbar stays outside its scrolling proposal list; short panels can scroll the task area. The React webview follows Cline's component structure but is driven by Forge's postMessage protocol; Cline's gRPC services and runtime state are not imported.
- **Borrowed content search:** ripgrep process collection, cancellation/cleanup and JSON match handling from `sdk/packages/core/src/extensions/tools/executors/search.ts`, at the same exact source commit, are adapted in `src/tools/EditorBridge.ts`. Forge supplies validated candidate paths, typed match parsing, explicit errors/budgets and centered matched-line excerpts. Cline context/executor types, indexer, fallback scanner and SDK imports are omitted; this is a partial helper adaptation, not the Cline agent loop.
- **Borrowed edit semantics:** the exactly-once `old_text` replacement and `insert_line` contract from `sdk/packages/core/src/extensions/tools/executors/editor.ts`, at the same exact source commit, are adapted in `src/edits/EditService.ts` and the `propose_edit` schema. Edits apply to the in-memory proposal for review instead of writing the file; Cline's disk writes, file creation and SDK types are omitted.
- **Changes and reasons:** the Forge URI scheme and UUIDs separate previews from Cline and from one another; an instance-owned content store and explicit disposal give our transaction service control over their lifetime; options objects clarify the adapted API. Immediate final rendering replaces Cline's simulated streaming animation so the preview shows the actual completed proposal. Cline animation, decorations, logging and SDK executor dependencies were omitted to keep the adapter independent of Cline's runtime.
- **Original preview adapter/test import:** `4e1a109b966c47f7dcf2e7527d4251283937e613` (`buid apply and undo`). That existing commit contains both the preview adaptation and our apply/undo implementation; it was not a standalone upstream import. The diff-row renderer is a later adaptation. The history is retained as it occurred.
- **Licence and attribution:** Forge Agent is licensed under [Apache-2.0](../LICENSE). Cline's original Apache-2.0 licence and copyright notice are preserved unchanged in [licenses/Cline-Apache-2.0.txt](../licenses/Cline-Apache-2.0.txt), with source attribution in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Dependencies retain their respective licences.

Our apply/undo transaction service and workspace guards were implemented for Forge Agent. The extension does not include Cline's agent loop, provider client or disk-writing SDK executor; model calls and tool iteration run in TrueForge. Future source adaptations should be introduced in dedicated commits naming their upstream paths and exact source commits.

Follow [the Cline-first reuse map](CLINE-REUSE.md) for editor work: inspect and adapt suitable upstream components before implementing equivalents. Custom code must have a concrete integration or behavior requirement; a fresh repository is not a reason to rebuild existing editor components.

## Run from a clean clone

Needs Node.js 22+, pnpm, VS Code with its `code` command, and a model key (a free Google Gemini key works).

```sh
git clone https://github.com/Mukulyadav2004/forge-agent.git && cd forge-agent
pnpm install --frozen-lockfile
pnpm run trueforge:local                 # terminal 1: local TrueForge 0.185.1 on http://127.0.0.1:8790
export GEMINI_API_KEY=...                # terminal 2: your key stays in your shell and in TrueForge
pnpm run trueforge:add-provider examples/model-provider.gemini.json
pnpm run dev                             # opens the Extension Development Host
```

In the Extension Development Host, open a trusted local project, then run **Forge: Open Agent** from the Command Palette. The status-bar button and activity-bar icon open the same sidebar.

Forge commands appear in the **Extension Development Host** launched by `pnpm run dev` or F5. Opening the source folder in a normal VS Code window does not load the development extension. If a command is missing, run `pnpm run dev` again and use the newly opened window. The sidebar also has a **Copy MCP connection** button.

## Connect your first model

1. In a separate terminal, run `pnpm run trueforge:local`. This starts pinned TrueForge `0.185.1` (the npm latest when checked on 17 Nov 2026) with the loopback editor MCP allowance. The extension does not start that server. Default URL: `http://127.0.0.1:8790`. The command refuses to start a second process on an occupied port; stop an older local server first.
2. Configure a model in TrueForge. Keep provider keys there, not in this extension or Git. The example configs in [examples/](../examples) are loaded with `pnpm run trueforge:add-provider <file>`, which fills `${GEMINI_API_KEY}`-style placeholders from your environment and creates or updates the provider. Any provider TrueForge supports works, including an OpenAI-compatible endpoint (`"type": "custom"` with a `base_url`); only Gemini models have been tested. Do not run the Gemini example over an existing `google-gemini` provider you configured differently: it replaces that provider's model list.
3. Click **Select model** in the sidebar, or run **Forge: Select Model**, to choose from your configured TrueForge models. Names include the exact provider prefix, such as `google-gemini/gemini-3-1-flash-lite`. If needed, set **Forge Agent: Base Url** in VS Code Settings first.
4. TrueForge must permit local outbound MCP connections. Start it with `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'` in its environment. Keep its outbound URL protections enabled.
5. Send a task. Before creating the session, the extension automatically registers its current MCP URL and bearer token through TrueForge's settings API. It uses a connector named `forge-editor-<window-id>`, so separate VS Code windows use their own editor tools.
6. Opening a folder or reloading the extension changes its port/token. The next new task registers the replacement connection automatically. The old manually configured `forge-editor` connector is not used by the updated extension.
7. **Forge: New Task** creates a new conversation; subsequent messages in a task reuse its TrueForge session. **Copy MCP connection** remains available for diagnostics and includes the actual connector name. Treat the copied header value as a credential.

If an older running development window reports `ECONNREFUSED` for a previous MCP port, run **Developer: Reload Window** once to load the updated build, then **Forge: New Task**. You should not need to edit a connector manually after opening a project.

The current client targets an unauthenticated local TrueForge development server. Authenticated server support has not been added. Both processes must run on the same host; a container has a different localhost.

If you manually change the model during an existing task, run **Forge: New Task** before sending another message. Selecting a model with the picker starts a new task automatically. Failed session creation no longer retains the old model setting.

## Agent definition

The TrueForge agent we use is [src/agent/forge-agent.json](../src/agent/forge-agent.json) (harness settings, step limit, editor tools and which tools need approval) plus the instructions in [src/agent/instructions.ts](../src/agent/instructions.ts). The extension loads it into every TrueForge session it creates (`POST /api/v1/sessions` with an inline spec) and into model switches (`PATCH`), filling in the model from **Forge Agent: Model** and the editor MCP server for the current window. TrueForge has no separate loader for agent files, so there is nothing to import by hand. To see exactly what TrueForge receives:

```sh
pnpm run agent:spec google-gemini/gemini-3-1-flash-lite
```

`run_command` always requires approval in TrueForge; the approval shows the exact command, folder and timeout, because a command can change files and Forge cannot undo it. `propose_edit` does not ask first: it only stages a diff, which you see in **Review changes** and the editor, and nothing is written until you accept it there. (One decision per edit instead of an approval followed by a review.)

## Models, fallback and Task C

- **Forge Agent: Model** is the main `provider/model`; **Forge Agent: Fallback Model** is optional. A failed turn is shown in the chat; temporary errors (429, 5xx, timeouts, connection failures) are retried after 2 s and 4 s, then the same session continues on the fallback model and your request is repeated. Errors such as an invalid key switch at once. Use a fallback on a different provider or key so it survives the same failure.
- Task C rehearsal providers: `pnpm run trueforge:add-provider examples/model-provider.task-c-invalid-key.json` (Google endpoint with a dummy key) and `examples/model-provider.task-c-unreachable.json` (a closed local port). Set **Model** to `taskc-invalid-key/gemini-3-1-flash-lite` or `taskc-unreachable/gemini-3-1-flash-lite` and **Fallback Model** to a working model, run **Forge: New Task**, repeat Task A, then check `git status` in the project. Both keys are dummies.

## What works in this milestone

- Sidebar messages and streamed assistant text, visible session/event status, errors, Cancel, and New Task.
- TrueForge tool approvals resume the same paused turn. Each approval names the file, kind of change and the agent's reason, or the exact command, folder and timeout, and warns about calls the editor will refuse.
- A live activity feed lists every search, read, proposal and command with the agent's stated reason, nests files under the search that found them, and shows the context budget.
- `run_command` runs one approved, non-interactive command in a workspace folder (default 60 s timeout, process group stopped on timeout or cancel, output kept to its start and end within 16,000 characters). Commands can change files and Forge cannot undo them; the tool log never stores command text or output.
- Each user request has a 200,000-character context budget across reads, searches, listings, command output and supplied context. Tools shrink their output to what remains, refuse when it is spent, and report usage to the agent and in the feed.
- Model errors are shown in plain words, retried with backoff when temporary, then handed to **Fallback Model** automatically.
- **Forge: Edit Selection** (`Cmd+Option+F` on Mac): select code, provide an instruction, send the selection and its location.
- Authenticated loopback MCP tools: `list_files`, bounded `read_file`, `search_code`, and `propose_edit`.
- `search_code` searches saved UTF-8 text by literal string or optional regex, returning paths, line numbers and matched excerpts in both text and structured results. Per request: five-second deadline, 1,000 candidate files, 256 KiB per file, 8 MiB of bytes inspected during text preflight, 100 results maximum (40 default), 1,000 characters per line and 20,000 characters of result JSON. Output collection is capped at 1 MiB. Dirty/secret/unavailable/oversized files are skipped; bounded text preflight rejects NUL bytes and invalid UTF-8 before ripgrep runs. Skipped candidates and exhausted result/file budgets are reported. No matches is scoped to these limits. Save dirty files to search them, or use `read_file` for current editor text and an edit revision. Search hits appear in the activity feed; only opened ranges appear in the file-evidence list. Start a **New Task** after reloading to enable the tool in a new TrueForge session.
- Sanitized Markdown, rendered Mermaid diagrams, and clickable source references. Raw HTML and remote images are not executed or loaded.
- A visible file-evidence list distinguishes MCP reads from source excerpts supplied as context. Architecture requests receive up to seven source files within a 64,000-character budget; larger files are excerpted and require further tool reads.
- Automatic registration of the active editor connection before session creation, with separate connector names for each extension host. Old inactive connector entries can remain in TrueForge Settings after a window closes.
- `read_file` returns an opaque `base_revision`. `propose_edit` requires that revision and stages a read-only diff through the Cline-derived preview adapter. One mode per call: `old_text` (exact text matching once), inclusive `start_line`/`end_line`, `insert_line`, or whole-file `new_text`. Partial edits to one file combine into a single pending review; line numbers refer to the file as read, overlaps are refused, and a whole-file proposal replaces earlier pending changes and is reported to the agent. Staging never writes files.
- **Review changes** offers Preview, Accept hunk, Reject hunk, Apply file, Reject, Apply all, Reject all, and Undo last apply. Each accepted hunk is saved immediately through the guarded transaction service. Every selected file must still match its staged editor/disk revision before a batch is applied.
- Accepted existing UTF-8 text files are saved; rollback is attempted on save/verification failures. Undo restores the last accepted batch only when its files still match our saved result. UTF-8 BOM and CRLF are preserved.
- Workspace trust checks, realpath containment for file reads, basic secret-path exclusion, and literal rendering of model/user text in the sidebar.

**Not implemented yet:** creating/deleting/renaming files, symbol tools and @-mentions, token-based (rather than character-based) context accounting, persistent sessions or conversation history, scout subagents, and a demonstrated compaction event. `run_command` is tested on macOS only. Content search is shared retrieval infrastructure, not a complete context assembly system. Basic secret-path exclusion is not a complete secret detector. This is a development milestone, not a contest-ready submission.

## Apply and undo

1. Save pre-existing unsaved changes in files you want the agent to edit.
2. Ask for an edit. The agent stages its proposal directly; it appears in **Review changes** as it is staged.
3. Review the actual diff, then use **Accept hunk**, **Apply file** or **Apply all** in the review panel. These are the only user-facing write actions; the model has no apply tool. Reject hunk discards only that pending hunk; remaining applies preserve its original lines.
4. Use **Undo last apply** or **Forge: Undo Last Apply** to restore the entire last accepted batch. If you have edited an affected file afterward, Undo refuses to overwrite that work.

`Forge: Apply All Proposed Changes` and `Forge: Reject All Proposed Changes` are also available in the Command Palette. Apply is disabled during model execution and tool approval. Cancellation and New Task invalidate pending proposals/read receipts; previously accepted batches remain available for Undo in the current extension host. Closing a preview tab does not reject its proposal; use Reject explicitly.

Editor text changes use one text-only `WorkspaceEdit` per batch. Files are saved separately, so this is not a crash-atomic filesystem transaction. Save/verification failures trigger rollback. If another writer or a persistent save failure makes safe rollback impossible, additional writes are blocked and the review panel shows the recovery snapshot path. Save participants that change the accepted content also cause verification failure.

Snapshots are written before applying under VS Code's extension global storage, in `edit-snapshots/`, outside the project. Each JSON file records the original bytes as base64 plus their SHA-256 hash; on POSIX systems snapshot files use mode `0600`. Keep them private. The last ten successful batches are undoable in memory. Reloading loses the undo stack and does not automatically recover a failed transaction; snapshots remain available for manual recovery. Automatic crash recovery is not implemented.

Hunks are contiguous changed line blocks computed locally with the `diff` dependency. After accepting a hunk, the service refreshes the expected revision and the preview for the remaining changes. Each accepted hunk creates one undo entry; Apply file/all creates one entry for the accepted batch. Undo discards any remaining pending hunks in the affected proposal, so request a fresh proposal before continuing that edit. Very complex diffs are refused with a request to split the edit.

## Rehearse fixed Task A

See [docs/TASK-A.md](TASK-A.md) for the exact instruction and recording steps. The scripts use a separate Flask 3.1.3 checkout under ignored `out-test/task-a/flask`; they do not modify another Flask checkout.

```sh
pnpm run task:a:prepare
pnpm run task:a:open
# After reviewing and accepting the agent's proposal:
pnpm run task:a:verify
# Deterministic editor integration check; no model call:
pnpm run test:task-a
# Same inline flow through a real configured TrueForge model:
pnpm run test:task-a --model google-gemini/gemini-3-5-flash
```

The deterministic test supplies a fixed proposal through MCP to check editor behavior; it is not evidence of model capability. The live mode uses the real inline command, TrueForge approvals and editor MCP tools. Both modes verify the Python behavior, run `tests/test_helpers.py`, undo accepted hunks and check the rehearsal Git tree is clean. Both require a clean rehearsal checkout at the start. Reports and screenshots are under `out-test/task-a/`.

## Verification

```sh
pnpm run check
pnpm run test:integration
pnpm run test:edits
pnpm run test:smoke
# All checks:
pnpm run test
# Verify a real local TrueForge server can discover the test editor tools:
pnpm run test:smoke --live-server
```

The integration test uses a local fake TrueForge HTTP server: it verifies the installed SDK's request/event handling, session reuse, approval input, cancellation request, and failed authentication. It does not call a model.

For a real project architecture evaluation, use the running editor connector name from **Copy MCP connection**:

```sh
pnpm run test:architecture --model <provider/model> --connector <editor-connector-name> --workspace /path/to/project
```

This performs a real model request and saves the report and coverage/format checks in `out-test/`. Those checks do not certify semantic accuracy. See `docs/QUALITY-NOV6.md` for the observed reasoning limitations.

To test a real configured model through your running local server (one greeting; uses your provider credentials and may incur usage):

```sh
pnpm run test:live --model google-gemini/gemini-3-1-flash-lite
```

The smoke test launches an isolated VS Code profile and project. It checks the sidebar and actual MCP bridge, three-file apply/undo, byte preservation, saved-file conflicts, dirty editor aliases, preview focus/cleanup, and recovery snapshot permissions. Output is under `out-test/`. Tests need the `code` CLI and installed VS Code. Transaction fault-injection tests exercise failed saves, rollback failure, concurrent writers, cancellation, and double acceptance without model calls.

The optional `--live-server` check expects local TrueForge at port 8790. It registers a temporary test connector, verifies discovery of all four tools through TrueForge, and removes that temporary connector afterward. It does not call a model. Native search checks run as part of `test:smoke`, with evidence in `out-test/search-result.json`. `test:live` checks only the model by default; use `--connector` with a running editor's copied connector name to attach its tools.

The build bundles TrueForge's ESM exports into the extension's CommonJS entry because the pinned SDK's published CommonJS entry fails when loaded directly. Do not replace the build with plain `tsc` emission.

## Read the code in this order

1. `src/extension.ts`: commands and extension startup.
2. `src/webview/App.tsx` and `src/shared/messages.ts`: sidebar ↔ extension communication.
3. `src/sidebar/AgentViewProvider.ts`: conversation, approvals, and state.
4. `src/agent/forge-agent.json` and `src/agent/ForgeSession.ts`: the agent definition and the TrueForge SDK boundary (sessions, turns, approvals, retry and fallback).
5. `src/tools/EditorBridge.ts` and `src/tools/runCommand.ts`: MCP tools, workspace access, context budget, proposed diffs and commands.
6. `docs/NOV-4-5-HANDOFF.md`: remaining real-world checks.
7. `src/context/projectContext.ts`, `src/agent/instructions.ts`, and `src/webview/lib/markdown.ts`: bounded context, evidence requirements, and safe presentation.
8. `src/edits/EditService.ts` and `docs/APPLY-UNDO.md`: proposal revisions, guarded transactions, snapshots, and undo.
