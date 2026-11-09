# Forge Agent

A VS Code extension that sends tasks to **local TrueForge**. TrueForge owns the model calls and agent loop. The extension supplies the sidebar and editor tools through MCP.

## Starting point, upstream source and licence

**Repository starting point: from scratch.** This repository is not a Git-history fork of Cline. Its initial commit is `05ffce16d5d405027ca1662dd104c5ecfdf27a16` in [Mukulyadav2004/forge-agent](https://github.com/Mukulyadav2004/forge-agent). Selected Cline editor code was adapted later; the Cline source commit below is a reuse reference, not an ancestor of this repository.

- **Upstream repository:** [cline/cline](https://github.com/cline/cline).
- **Source checkout:** [Mukulyadav2004/myAiCodingAssistant](https://github.com/Mukulyadav2004/myAiCodingAssistant).
- **Exact source commit:** `7a7878cb52fc33967d8b464b3e3d899beac42d4d`.
- **Borrowed implementation:** `apps/vscode/src/hosts/vscode/VscodeEditPreview.ts`, adapted as [src/editor/ClineEditPreview.ts](src/editor/ClineEditPreview.ts). It supplies virtual documents, the native VS Code diff preview, focus preservation and precise preview-tab cleanup. The focus-preservation scenario from `apps/vscode/src/hosts/vscode/VscodeEditPreview.test.ts` was also adapted in [test/edits/realEditor.ts](test/edits/realEditor.ts).
- **Borrowed review rendering:** `DiffLine` and the old/new line-counter behavior from `apps/vscode/webview-ui/src/components/chat/DiffEditRow.tsx`, adapted as [src/webview/ClineDiffLines.ts](src/webview/ClineDiffLines.ts) from the same exact source commit. The DOM port retains line gutters, change markers, indicator bars and changed-line colors; uses VS Code theme variables; preserves code indentation; and consumes computed hunks without Cline's controller or patch-parser dependencies.
- **Borrowed layout:** the grid/flex layout from `apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/ChatLayout.tsx` and content/footer separation in `apps/vscode/webview-ui/src/components/chat/ChatView.tsx`, at the same source commit, are adapted in [media/sidebar.css](media/sidebar.css) and the sidebar template. The DOM port uses a compact header, a scrolling task area and a separate bottom composer. Forge's review toolbar stays outside its scrolling proposal list; short panels can scroll the task area. React, styled-components and Cline's message/runtime state are not imported.
- **Changes and reasons:** the Forge URI scheme and UUIDs separate previews from Cline and from one another; an instance-owned content store and explicit disposal give our transaction service control over their lifetime; options objects clarify the adapted API. Immediate final rendering replaces Cline's simulated streaming animation so the preview shows the actual completed proposal. Cline animation, decorations, logging and SDK executor dependencies were omitted to keep the adapter independent of Cline's runtime.
- **Original preview adapter/test import:** `4e1a109b966c47f7dcf2e7527d4251283937e613` (`buid apply and undo`). That existing commit contains both the preview adaptation and our apply/undo implementation; it was not a standalone upstream import. The diff-row renderer is a later adaptation. The history is retained as it occurred.
- **Licence and attribution:** Forge Agent is licensed under [Apache-2.0](LICENSE). Cline's original Apache-2.0 licence and copyright notice are preserved unchanged in [licenses/Cline-Apache-2.0.txt](licenses/Cline-Apache-2.0.txt), with source attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Dependencies retain their respective licences.

Our apply/undo transaction service and workspace guards were implemented for Forge Agent. The extension does not include Cline's agent loop, provider client or disk-writing SDK executor; model calls and tool iteration run in TrueForge. Future source adaptations should be introduced in dedicated commits naming their upstream paths and exact source commits.

Follow [the Cline-first reuse map](docs/CLINE-REUSE.md) for editor work: inspect and adapt suitable upstream components before implementing equivalents. Custom code must have a concrete integration or behavior requirement; a fresh repository is not a reason to rebuild existing editor components.

## Run

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

In the Extension Development Host, open a trusted local project, then run **Forge: Open Agent** from the Command Palette. The status-bar button and activity-bar icon open the same sidebar.

Forge commands appear in the **Extension Development Host** launched by `pnpm run dev` or F5. Opening the source folder in a normal VS Code window does not load the development extension. If a command is missing, run `pnpm run dev` again and use the newly opened window. The sidebar also has a **Copy MCP connection** button.

## Connect your first model

1. In a separate terminal, run `pnpm run trueforge:local`. This starts pinned TrueForge `0.184.2` with the loopback editor MCP allowance. The extension does not start that server. Default URL: `http://127.0.0.1:8790`. The command refuses to start a second process on an occupied port; stop an older local server first.
2. Configure a model in TrueForge. Keep provider keys there, not in this extension or Git.
3. Click **Select model** in the sidebar, or run **Forge: Select Model**, to choose from your configured TrueForge models. Names include the exact provider prefix, such as `google-gemini/gemini-3-1-flash-lite`. If needed, set **Forge Agent: Base Url** in VS Code Settings first.
4. TrueForge must permit local outbound MCP connections. Start it with `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'` in its environment. Keep its outbound URL protections enabled.
5. Send a task. Before creating the session, the extension automatically registers its current MCP URL and bearer token through TrueForge's settings API. It uses a connector named `forge-editor-<window-id>`, so separate VS Code windows use their own editor tools.
6. Opening a folder or reloading the extension changes its port/token. The next new task registers the replacement connection automatically. The old manually configured `forge-editor` connector is not used by the updated extension.
7. **Forge: New Task** creates a new conversation; subsequent messages in a task reuse its TrueForge session. **Copy MCP connection** remains available for diagnostics and includes the actual connector name. Treat the copied header value as a credential.

If an older running development window reports `ECONNREFUSED` for a previous MCP port, run **Developer: Reload Window** once to load the updated build, then **Forge: New Task**. You should not need to edit a connector manually after opening a project.

The current client targets an unauthenticated local TrueForge development server. Authenticated server support has not been added. Both processes must run on the same host; a container has a different localhost.

If you manually change the model during an existing task, run **Forge: New Task** before sending another message. Selecting a model with the picker starts a new task automatically. Failed session creation no longer retains the old model setting.

## What works in this milestone

- Sidebar messages and streamed assistant text, visible session/event status, errors, Cancel, and New Task.
- TrueForge tool approval events with approve/deny resumed as a new turn in the same session.
- **Forge: Edit Selection** (`Cmd+Option+F` on Mac): select code, provide an instruction, send the selection and its location.
- Authenticated loopback MCP tools: `list_files`, bounded `read_file`, and `propose_edit`.
- Sanitized Markdown, rendered Mermaid diagrams, and clickable source references. Raw HTML and remote images are not executed or loaded.
- A visible file-evidence list distinguishes MCP reads from source excerpts supplied as context. Architecture requests receive up to seven source files within a 64,000-character budget; larger files are excerpted and require further tool reads.
- Automatic registration of the active editor connection before session creation, with separate connector names for each extension host. Old inactive connector entries can remain in TrueForge Settings after a window closes.
- `read_file` returns an opaque `base_revision`. `propose_edit` requires that revision and stages a read-only diff through the Cline-derived preview adapter. Optional inclusive `start_line` and `end_line` replace only complete lines, preserving surrounding code. Staging never writes files.
- **Review changes** offers Preview, Accept hunk, Reject hunk, Apply file, Reject, Apply all, Reject all, and Undo last apply. Each accepted hunk is saved immediately through the guarded transaction service. Every selected file must still match its staged editor/disk revision before a batch is applied.
- Accepted existing UTF-8 text files are saved; rollback is attempted on save/verification failures. Undo restores the last accepted batch only when its files still match our saved result. UTF-8 BOM and CRLF are preserved.
- Workspace trust checks, realpath containment for file reads, basic secret-path exclusion, and literal rendering of model/user text in the sidebar.

**Not implemented yet:** creating/deleting/renaming files, command execution, code search/symbol tools, context selection reasons and token accounting, automatic model fallback, persistent sessions or conversation history, and scout subagents. Basic secret-path exclusion is not a complete secret detector. This is a development milestone, not a contest-ready submission.

## Apply and undo

1. Save pre-existing unsaved changes in files you want the agent to edit.
2. Ask for an edit. Allow TrueForge to stage the preview when its tool approval appears.
3. Review the actual diff, then use **Accept hunk**, **Apply file** or **Apply all** in the review panel. These are the only user-facing write actions; the model has no apply tool. Reject hunk discards only that pending hunk; remaining applies preserve its original lines.
4. Use **Undo last apply** or **Forge: Undo Last Apply** to restore the entire last accepted batch. If you have edited an affected file afterward, Undo refuses to overwrite that work.

`Forge: Apply All Proposed Changes` and `Forge: Reject All Proposed Changes` are also available in the Command Palette. Apply is disabled during model execution and tool approval. Cancellation and New Task invalidate pending proposals/read receipts; previously accepted batches remain available for Undo in the current extension host. Closing a preview tab does not reject its proposal; use Reject explicitly.

Editor text changes use one text-only `WorkspaceEdit` per batch. Files are saved separately, so this is not a crash-atomic filesystem transaction. Save/verification failures trigger rollback. If another writer or a persistent save failure makes safe rollback impossible, additional writes are blocked and the review panel shows the recovery snapshot path. Save participants that change the accepted content also cause verification failure.

Snapshots are written before applying under VS Code's extension global storage, in `edit-snapshots/`, outside the project. Each JSON file records the original bytes as base64 plus their SHA-256 hash; on POSIX systems snapshot files use mode `0600`. Keep them private. The last ten successful batches are undoable in memory. Reloading loses the undo stack and does not automatically recover a failed transaction; snapshots remain available for manual recovery. Automatic crash recovery is not implemented.

Hunks are contiguous changed line blocks computed locally with the `diff` dependency. After accepting a hunk, the service refreshes the expected revision and the preview for the remaining changes. Each accepted hunk creates one undo entry; Apply file/all creates one entry for the accepted batch. Undo discards any remaining pending hunks in the affected proposal, so request a fresh proposal before continuing that edit. Very complex diffs are refused with a request to split the edit.

## Rehearse fixed Task A

See [docs/TASK-A.md](docs/TASK-A.md) for the exact instruction and recording steps. The scripts use a separate Flask 3.1.3 checkout under ignored `out-test/task-a/flask`; they do not modify another Flask checkout.

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

The optional `--live-server` check expects local TrueForge at port 8790. It registers a temporary test connector, verifies all three tools through TrueForge, and removes that temporary connector afterward. It does not call a model. `test:live` checks only the model by default; use `--connector` with a running editor's copied connector name to attach its tools.

The build bundles TrueForge's ESM exports into the extension's CommonJS entry because the pinned SDK's published CommonJS entry fails when loaded directly. Do not replace the build with plain `tsc` emission.

## Read the code in this order

1. `src/extension.ts`: commands and extension startup.
2. `src/webview/main.ts` and `src/shared/messages.ts`: sidebar ↔ extension communication.
3. `src/sidebar/AgentViewProvider.ts`: conversation, approvals, and state.
4. `src/agent/ForgeSession.ts`: the TrueForge SDK boundary and agent definition.
5. `src/tools/EditorBridge.ts`: MCP, workspace access, proposed diffs.
6. `docs/NOV-4-5-HANDOFF.md`: remaining real-world checks.
7. `src/context/projectContext.ts`, `src/agent/instructions.ts`, and `src/webview/markdown.ts`: bounded context, evidence requirements, and safe presentation.
8. `src/edits/EditService.ts` and `docs/APPLY-UNDO.md`: proposal revisions, guarded transactions, snapshots, and undo.
