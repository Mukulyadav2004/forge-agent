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
| Content search | `sdk/packages/core/src/extensions/tools/executors/search.ts` | Reuse candidate for the next retrieval milestone. Adapt bounded output, cancellation and ripgrep handling; replace Cline context/index dependencies and apply our workspace boundaries. Not implemented yet. |
| Filename discovery and fuzzy matching | `apps/vscode/src/services/search/file-search.ts` | Reuse candidate for file discovery and mentions. Remove host-provider, generated-protocol, telemetry and workspace-manager dependencies as appropriate. Not implemented yet. |
| Context mentions | `apps/vscode/webview-ui/src/utils/context-mentions.ts` | Reuse candidate for trigger/filter behavior; replace unsupported context kinds and controller integration. Not implemented yet. |
| Rich syntax-highlighted diff component | `sdk/packages/ui/components/agent-chat/tool-diff.tsx` | Further UI reuse candidate. Requires React and `@pierre/diffs`, including theme/CSP integration; it is not a drop-in component in the current DOM webview. Not implemented yet. |
| Write coordination | `apps/vscode/src/sdk/sdk-diff-edit-coordinator.ts` | Not a drop-in replacement for our transaction service: inspected code can proceed when a cosmetic preview fails and previews only the first changed file of a multi-file patch. Our required behavior validates each selected revision and supports individual hunk decisions, batch rollback and guarded undo. Keep those requirements while evaluating isolated helpers for reuse. |

The per-hunk acceptance transaction is not a standalone implementation found in the inspected Cline components. This does not assert that every historical or future Cline version lacks that feature.

## Layout port: 9 Nov 2026

Before: a large setup header and composer competed with the flex-shrinking review section, leaving its controls clipped. After: the outer grid reserves space for the compact header and composer; the middle task area gets the remaining height. Review comes before file evidence and conversation. Its actions sit outside the scrolling proposal list. Very short panels scroll the task area rather than collapsing the review section.

Validated with `pnpm run check` and `pnpm run test:smoke`: real VS Code/MCP apply and undo, plus layout fixtures capped at 360 by 720, 240 by 480, and 360 by 600 with 150% text/spacing. Fixtures use the available webview width if narrower. Undo/composer visibility and toolbar position while scrolling are checked. Screenshots: `out-test/sidebar-layout-{normal,narrow-short,large-text}.png`. The enlarged-text fixture is not a full VS Code zoom test. Live TrueForge/model generation was not rerun.

This ports the layout, not Cline's entire interface. The existing Forge conversation and guarded review logic remain. Loading the new template requires a development-host reload, which clears in-memory undo history; undo any current failed attempt first or retain its original host window.

Preserve upstream licences, identify adapted files and modifications in the README and third-party notices, and keep new source imports identifiable in Git history. Do not rewrite the existing history to manufacture fork ancestry or a separate historical import.
