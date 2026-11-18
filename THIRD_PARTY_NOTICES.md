# Third-party source attribution

## Cline editor preview

- Upstream: https://github.com/cline/cline
- Local fork used: https://github.com/Mukulyadav2004/myAiCodingAssistant
- Exact source commit: `7a7878cb52fc33967d8b464b3e3d899beac42d4d`
- Copyright: 2026 Cline Bot Inc.
- License: Apache License 2.0; the original license and copyright notice are retained in `licenses/Cline-Apache-2.0.txt`.
- Source: `apps/vscode/src/hosts/vscode/VscodeEditPreview.ts`.
- Adapted implementation: `src/editor/ClineEditPreview.ts`.
- Original import in Forge Agent: `4e1a109b966c47f7dcf2e7527d4251283937e613` (`buid apply and undo`), together with Forge Agent's transaction implementation. This repository started from scratch; the Cline source commit is not a Git ancestor.
- Changes: Forge URI scheme, instance-owned content store, cryptographic preview IDs, explicit disposal, options-object parameters, and immediate final diff rendering. Animation, decorations, Cline logging, and the Cline SDK executor connection are omitted. Exact matching of original/modified virtual-document URIs and focus-preserving preview behavior are retained.
- The real VS Code tests cover focus preservation, independent previews for the same path, closing only the selected preview, and leaving the real file unchanged before acceptance. `test/edits/realEditor.ts` includes an adaptation of the focus-preservation test from `apps/vscode/src/hosts/vscode/VscodeEditPreview.test.ts` at the same source commit.

The apply/undo transaction service and workspace guards are Forge Agent's implementation. No Cline agent loop, provider client, or disk-writing SDK executor is included.

## Cline diff-line rendering

- Upstream, source checkout, exact commit and licence: the same Cline source point recorded above.
- Source: `apps/vscode/webview-ui/src/components/chat/DiffEditRow.tsx`, specifically `DiffLine` and the old/new line counters in `FileBlock`.
- Adapted implementation: originally `src/webview/ClineDiffLines.ts`; now `src/webview/components/review/DiffLines.tsx` (see "Cline sidebar chat UI" below), integrated by `src/webview/components/review/ReviewPanel.tsx`.
- Retained behavior: changed-line tints and indicator bars, line-number gutter, explicit addition/deletion prefixes, code content and separate counters for removed/added lines.
- Changes and reasons: ported React/Tailwind rendering to safe DOM nodes and VS Code theme variables; accepts the host's computed hunks instead of parsing model patch strings; preserves all code indentation after the single diff marker; handles CRLF and terminal-newline display explicitly. Like the upstream component's unknown-position behavior, line numbers are hidden after rejection/undo can invalidate proposed offsets. Cline gRPC services, file-opening dependencies and unused patch parsers are omitted.
- Full native previews still use the Cline-derived virtual-document adapter. Hunk decisions and guarded apply/undo remain Forge Agent implementations.

## Cline chat layout

- Upstream, exact commit, copyright and Apache-2.0 licence: the same Cline source point recorded above.
- Sources: `apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/ChatLayout.tsx` and the content/footer structure in `apps/vscode/webview-ui/src/components/chat/ChatView.tsx`.
- Adaptation: originally `media/sidebar.css` and the sidebar template; now `src/webview/components/chat/ChatView.tsx` and `src/webview/index.css` (see "Cline sidebar chat UI" below). Retains full-height grid, constrained scrolling content and a separate composer.
- Forge-specific changes: compact setup/status controls, independently scrolling proposals with review actions outside that scroll area, space shared with conversation, and outer task scrolling when the panel is too short. Cline's React state, virtualized message list, SDK and provider runtime are not included.

## Cline sidebar chat UI

- Upstream: https://github.com/cline/cline; exact source commit `eff43e19b267e171f597ab03733bfed25090f72d`; copyright 2026 Cline Bot Inc.; Apache-2.0 licence preserved in `licenses/Cline-Apache-2.0.txt`.
- Sources (under `apps/vscode/webview-ui/src/`): `components/chat/ChatView.tsx`, `chat-view/components/layout/*`, `ChatRow.tsx`, `task-header/TaskHeader.tsx` and `ContextWindow.tsx`, `ChatTextArea.tsx`, `chat-view/components/layout/ActionButtons.tsx`, `OptionsButtons.tsx`, `DiffEditRow.tsx`, `components/history/HistoryView.tsx`, `components/welcome/WelcomeSection.tsx` and the `@theme` VS Code variable mapping in `theme.css`.
- Adapted in: `src/webview/components/**` and `src/webview/index.css`; each derived file carries a header naming its source. `src/webview/App.tsx` (host-state wiring) is Forge Agent's own code.
- Changes: driven by Forge's postMessage protocol (`src/shared/messages.ts`) instead of Cline's gRPC/proto services and ExtensionState context; Forge activity entries, review panel, model menu, spin agents and agent tabs replace Cline's tool/message types; markdown stays on Forge's Marked + DOMPurify renderer; inline SVG icons instead of codicons/lucide; no virtualized list, styled-components, HeroUI or Cline runtime.

## Webview runtime dependencies

- `react@18.3.1`, `react-dom@18.3.1` and their dependency `scheduler@0.23.2` (MIT, Meta Platforms, Inc.): `licenses/React-MIT.txt` (identical for react and react-dom) and `licenses/scheduler-MIT.txt`.
- `clsx@2.1.1` (MIT, Luke Edwards): `licenses/clsx-MIT.txt`.
- `tailwindcss@4.1.13` (MIT, Tailwind Labs, Inc.) generates `out-webview/webview/main.css`, including its preflight base styles: `licenses/tailwindcss-MIT.txt`.

## Cline content-search helper

- Upstream: https://github.com/cline/cline; exact source commit `7a7878cb52fc33967d8b464b3e3d899beac42d4d`; copyright 2026 Cline Bot Inc.; Apache-2.0 licence preserved in `licenses/Cline-Apache-2.0.txt`.
- Source: `sdk/packages/core/src/extensions/tools/executors/search.ts`; process/output collection, cancellation/finalization and ripgrep JSON match handling adapted in `src/tools/EditorBridge.ts`.
- Changes: VS Code's bundled executable, guarded explicit candidate paths, aggregate/file/output/time limits, literal default with optional regex, bounded stderr and typed JSON validation, centered source excerpts, explicit errors and MCP structured results. Secret-target aliases and dirty buffers are excluded through Forge's canonical WorkspaceFiles owner.
- Omitted: Cline AgentToolContext/SearchExecutor imports, workspace index, manual fallback scanner and agent/provider/SDK integration. TrueForge selects and orchestrates the MCP tool; the helper only executes a bounded local search.

## Cline exact-text and insert edit semantics

- Upstream: https://github.com/cline/cline; exact source commit `7a7878cb52fc33967d8b464b3e3d899beac42d4d`; copyright 2026 Cline Bot Inc.; Apache-2.0 licence preserved in `licenses/Cline-Apache-2.0.txt`.
- Source: `sdk/packages/core/src/extensions/tools/executors/editor.ts` (`replaceInFile`, `insertInFile`, the `old_text`/`insert_line` contract and its error wording).
- Adapted in: `src/edits/EditService.ts` (exactly-once `old_text` match with a literal replacer; insert-before-line boundary) and the `propose_edit` schema in `src/tools/EditorBridge.ts`.
- Changes: edits apply to the in-memory pending proposal, never to disk; line numbers refer to the file as read and are shifted past earlier pending changes; overlaps are refused; Forge's revision, conflict, review and undo checks are unchanged. Omitted: file creation, Cline path resolution, `node:fs` writes, line-ending helpers, `@cline/shared` and executor types.

## jsdiff dependency

- Package: `diff@8.0.2`, https://github.com/kpdecker/jsdiff.
- Used for bounded line-diff computation in `src/edits/lineChanges.ts`. Per-hunk decisions, transactions and review controls are Forge Agent's implementation.
- BSD-3-Clause copyright and licence are preserved in `licenses/jsdiff-BSD-3-Clause.txt` for bundled distribution.
