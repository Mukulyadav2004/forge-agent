# Cline-first editor reuse

Start with a fresh extension repository and reuse suitable Cline editor implementations before writing replacements. A fresh repository does not mean implementing the editor from scratch.

For each editor feature, inspect Cline at the declared source commit, record the source paths and dependencies, adapt usable components, and explain any necessary custom behavior. Reuse is judged by functioning components and traceable provenance, not line count. Do not copy unrelated files or add unused implementations to increase the apparent amount of reuse.

TrueForge owns model calls, model/tool iteration, session lifecycle, streaming, approval orchestration, conversation compaction and subagent orchestration. File-operation helpers and search executors from Cline can be adapted as editor MCP tools; their original directory name does not make them an agent loop.

## Inspected source and decisions

Source checkout: `https://github.com/Mukulyadav2004/myAiCodingAssistant`, commit `7a7878cb52fc33967d8b464b3e3d899beac42d4d`; upstream `https://github.com/cline/cline`.

| Editor component | Cline source | Decision |
| --- | --- | --- |
| Native read-only diff preview | `apps/vscode/src/hosts/vscode/VscodeEditPreview.ts` | Already adapted in `src/editor/ClineEditPreview.ts`; retain virtual documents, focus behavior and exact-tab cleanup. |
| Diff rows in the review panel | `apps/vscode/webview-ui/src/components/chat/DiffEditRow.tsx` | Adapted its changed-line rendering and old/new line-counter behavior in `src/webview/ClineDiffLines.ts`; replaces our basic excerpt blocks. |
| Chat layout | `apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/ChatLayout.tsx` and `apps/vscode/webview-ui/src/components/chat/ChatView.tsx` | Adapted grid/flex containment and content/footer separation in `media/sidebar.css` and the sidebar template. Compact header; separate composer; Forge review actions above a scrolling proposal list. Short panels scroll the task area. React/styled-components and Cline runtime state are omitted; this is a layout port, not a complete Cline UI migration. |
| Review feedback to the agent | `apps/vscode/src/core/context/context-tracking/FileContextTracker.ts`, `apps/vscode/src/sdk/tool-approval-denial.ts` and checkpoint restore controller | Inspected Cline's pending file-change tracking and explicit edit-denial feedback. These depend on its controller/SDK; no source is copied for this feature. Forge's bounded ReviewFeedback queue reports actual review outcomes through TrueForge user-message input, preserving the session and keeping approval resumes separate. |
| Content search | `sdk/packages/core/src/extensions/tools/executors/search.ts` | User approved starting context search after the dependency/trade-off assessment in AGENT-MODE-PLAN.md. Partially adapted process collection, cancellation/finalization and JSON match handling in EditorBridge.ts, replacing Cline contracts/index/fallback with guarded paths, explicit limits/errors and structured MCP source excerpts. No Cline imports or orchestration are retained. |
| Filename discovery and fuzzy matching | `apps/vscode/src/services/search/file-search.ts` | Reuse candidate for file discovery and mentions. Remove host-provider, generated-protocol, telemetry and workspace-manager dependencies as appropriate. Not implemented yet. |
| Context mentions | `apps/vscode/webview-ui/src/utils/context-mentions.ts` | Reuse candidate for trigger/filter behavior; replace unsupported context kinds and controller integration. Not implemented yet. |
| Rich syntax-highlighted diff component | `sdk/packages/ui/components/agent-chat/tool-diff.tsx` | Further UI reuse candidate. Requires React and `@pierre/diffs`, including theme/CSP integration; it is not a drop-in component in the current DOM webview. Not implemented yet. |
| Write coordination | `apps/vscode/src/sdk/sdk-diff-edit-coordinator.ts` | Not a drop-in replacement for our transaction service: inspected code can proceed when a cosmetic preview fails and previews only the first changed file of a multi-file patch. Our required behavior validates each selected revision and supports individual hunk decisions, batch rollback and guarded undo. Keep those requirements while evaluating isolated helpers for reuse. |

The per-hunk acceptance transaction is not a standalone implementation found in the inspected Cline components. This does not assert that every historical or future Cline version lacks that feature.

## Layout port: 9 Nov 2026

Before: a large setup header and composer competed with the flex-shrinking review section, leaving its controls clipped. After: the outer grid reserves space for the compact header and composer; the middle task area gets the remaining height. Review comes before file evidence and conversation. Its actions sit outside the scrolling proposal list. Very short panels scroll the task area rather than collapsing the review section.

Validated with `pnpm run check` and `pnpm run test:smoke`: real VS Code/MCP apply and undo, plus layout fixtures capped at 360 by 720, 240 by 480, and 360 by 600 with 150% text/spacing. Fixtures use the available webview width if narrower. Undo/composer visibility and toolbar position while scrolling are checked. Screenshots: `out-test/sidebar-layout-{normal,narrow-short,large-text}.png`. The enlarged-text fixture is not a full VS Code zoom test. Live TrueForge/model generation was not rerun.

This ports the layout, not Cline's entire interface. The existing Forge conversation and guarded review logic remain. Loading the new template requires a development-host reload, which clears in-memory undo history; undo any current failed attempt first or retain its original host window.

## Review synchronization: 10 Nov 2026

`src/sidebar/ReviewFeedback.ts` owns pending review outcomes. The sidebar records apply/reject/hunk/undo results, including failures and per-status hunk counts, without source text. The next ordinary user request sends the summary through TrueForge in the same session; approval resumes remain separate. Successful delivery clears the queue; failed or cancelled sends retain it, and New Task clears it. There is no model call for a review click. The summary is bounded to 16 outcomes and 12,000 characters of records, with omission markers; each outcome lists at most eight changed proposals.

The summary describes past review actions, not a fresh filesystem snapshot. Agent instructions require a current MCP read before another edit, including repeating a task after Undo. Existing revision checks still guard writes. General external-file watching is not implemented.

Validation: `pnpm run check`, all five `test:integration` checks, and `pnpm run test:smoke` passed. The native editor regression exercises apply/undo/repeat with the same SDK session, a fresh MCP proposal, partial review, silent previews, no extra model calls, failed-send retry and New Task cleanup. It uses a local HTTP/SSE fixture; live TrueForge/model behavior was not rerun. Artifact: `out-test/review-feedback-result.json`. One smoke attempt timed out during slow editor startup; the complete rerun passed.

## Content search: 11 Nov 2026

After the import-by-import assessment and the user's instruction to start context search, adapted the ripgrep process/output, cancellation/finalization and JSON match handling from the recorded Cline search executor. EditorBridge exposes `search_code` with literal/regex queries, relative globs, case control and bounded results. WorkspaceFiles remains the canonical owner of trust, realpath, secret-path and dirty-buffer checks; secret checks now cover resolved targets as well as requested paths. No Cline package imports, model/provider calls or agent loop were introduced. Cline's indexer, fallback scanner and executor/context contracts were omitted.

Limits are visible in MCP results: 1,000 candidates, 256 KiB per file, 8 MiB inspected during UTF-8/NUL preflight, 40 default/100 maximum matches, 1,000 characters per source line, 20,000 result characters, 1 MiB collected rg output, 64,000 characters of path arguments and a five-second deadline. Truncation and skipped candidates are explicit. Preflight reads saved bytes locally; only matched excerpts enter the tool response. Search is a shared retrieval primitive, not a token budget, @-mention picker or automatic context-selection ledger. The agent must still call read_file before proposing an edit.

Native editor/MCP checks and live TrueForge 0.184.2 connector discovery passed with `pnpm run test:smoke -- --live-server`. Evidence: `out-test/search-result.json` and `out-test/live-editor-result.json`. Tests cover source/test/docs discovery, literal/regex/case/dash queries, centered Unicode excerpts, result/raw-output/file-byte/candidate limits, no-match/error distinctions, secret/outside symlinks, binary/invalid-UTF-8/oversized/dirty exclusions, cancelled-client recovery and unchanged fixture files. The first binary test exposed rg JSON emitting a match before its binary notification; bounded preflight fixes that. A later run completed assertions but failed temporary-profile cleanup with ENOTEMPTY; the complete rerun exited successfully. Live model selection of search, mid-process cancellation timing and cross-platform executable packaging remain unverified.

Preserve upstream licences, identify adapted files and modifications in the README and third-party notices, and keep new source imports identifiable in Git history. Do not rewrite the existing history to manufacture fork ancestry or a separate historical import.
