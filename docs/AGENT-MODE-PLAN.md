# Agent mode: source assessment and proposed steps

Prepared 11 November 2026. This is a proposal, not implemented capability. Streaming/Cancel has a real-model pass recorded in STEP-NOTES.md; Agent mode still needs bounded search, approved command execution and a three-file live task. No Cline source is copied in this assessment.

## 1. Search: inspected source and imports

Source: `https://github.com/cline/cline`, local checkout `Mukulyadav2004/myAiCodingAssistant`, commit `7a7878cb52fc33967d8b464b3e3d899beac42d4d`. Candidate: `sdk/packages/core/src/extensions/tools/executors/search.ts` (521 lines). This is an isolated search executor, not a model/provider/agent loop. Being under the SDK directory does not require importing the Cline SDK.

| Import | Used for | Proposed treatment |
| --- | --- | --- |
| `node:child_process` → `spawn` | Probe/run ripgrep and collect its output | Retain Node process primitives; pass arguments without a shell and terminate on timeout/cancellation. |
| `node:fs/promises` | Read full files in the manual-regex fallback | Omit that fallback initially; route any source excerpts through Forge's guarded WorkspaceFiles owner. |
| `node:path` | Paths/extensions and fallback filtering | Retain only required path operations; preserve realpath containment and secret exclusions. |
| `@cline/shared` → `AgentToolContext` | Search uses its AbortSignal | Remove the Cline import; accept a small options object with an AbortSignal. Do not duplicate its broader agent context. |
| `../../../services/workspace` → `getFileIndex` | Supply fallback candidate files | Replace with bounded VS Code workspace enumeration and Forge path validation. Do not pull in Cline's indexer, worker or cache. |
| `../types` → `SearchExecutor` | Function signature returning formatted results | Replace with Forge's MCP input/output contract; no Cline executor/controller types remain. |
| `./output-limits` → `MAX_LINE_CHARS`, `MAX_SEARCH_OUTPUT_CHARS` | Line/output caps (2,000 / 48,000 chars upstream) | Use explicitly documented Forge limits. Any copied helper gets attribution; do not import the Cline module just for constants. |

Potentially reusable portions: bounded process/output collection, termination paths and ripgrep JSON result handling. The upstream fast path searches the working directory without applying the fallback's configured file filters, uses a positional pattern, and can fall back after an abort/no-match. Those behaviors need adaptation: validate candidate paths before searching, pass the pattern as data, distinguish no-match/error/cancel, and never restart a cancelled search through a fallback. Output should include matched source and explicit truncation, including structured MCP results.

The installed VS Code application contains `node_modules/@vscode/ripgrep/bin/rg`; its location was inspected. Resolve availability at runtime and fail clearly if unavailable rather than relying silently on a developer's shell PATH. Cross-platform packaging still requires verification.

## 2. Adapt or implement independently?

| Option | Rough production change size, excluding tests | Trade-off |
| --- | --- | --- |
| Adapt Cline's ripgrep/process/result portions | About 160–260 lines including Forge MCP integration; estimates, not a promised copied-line count | Retains suitable upstream work and regex/process behavior. Needs sound JSON guards, scoped candidates, explicit cancellation and Forge safety/output contracts. Whole-file copying would import unnecessary fallback/index machinery. Recommended. |
| Implement a bounded literal scanner with VS Code enumeration and guarded reads | About 130–220 lines including integration | Fewer process dependencies, but scans candidate content in JavaScript and initially offers less capable search. Less code reuse and potentially worse performance; a smaller diff alone is not a reason to choose it. |

The recommended compact implementation can live in the existing EditorBridge module for this first tool. Expected non-test files: `src/tools/EditorBridge.ts`, `src/workspace/WorkspaceFiles.ts`, `src/agent/ForgeSession.ts`, README, THIRD_PARTY_NOTICES, CLINE-REUSE and STEP-NOTES. WorkspaceFiles needs to expose its existing guarded path resolution for search rather than duplicating policy or opening every candidate document. This is seven files and may exceed the saved AGENTS.md three-file/about-150-line step limit and the six-file allowance previously discussed in chat. Approval must cover the adaptation choice and either a bounded exception for this step or a smaller split before implementation. No unused intermediate copies should be committed just to satisfy a split.

## 3. Search acceptance criteria

- Expose `search_code` through the editor MCP server and enable it in new TrueForge sessions. No direct model calls or competing loop.
- Bound candidate count, source bytes, result count, excerpt length, output characters and runtime; disclose incomplete coverage. Initial limits will be chosen and tested during implementation, not described as a token budget.
- Preserve workspace trust, realpath containment, secret exclusions and safe handling of symlinks, binary/large files, regex errors and patterns beginning with a dash.
- Return paths, line numbers and matched source in both text and structured MCP content. Search does not issue edit revisions; propose_edit still requires read_file.
- Test through native VS Code/MCP, then a real TrueForge task. Finding definitions, tests and documentation is the target; a file listing alone does not count as understanding source.
- Search is shared infrastructure for context assembly, not completion of mentions, retrieval reasons or the context ledger.

## 4. Command execution: next separate step

Inspected Cline candidates: `sdk/packages/core/src/extensions/tools/executors/bash.ts` (1,182 lines) and `run-command-execution-controller.ts` (43 lines). The executor imports Node process/filesystem/OS/path/decoder utilities; Cline AgentToolContext and shell helpers; process-start-token probing; TimeoutError/ShellExecutor contracts; output collection limits/helpers; and an execution controller. It supports detached logs and session/tool-call-managed background execution. The controller coordinates that detached execution and will not be copied into Forge.

Before copying command helper code, provide a separate import/use/replacement assessment and size comparison. A minimal foreground-only runner is roughly 150–250 production lines before approval UI and MCP wiring; a substantial port of the complete executor is likely several hundred lines with more dependencies. These are planning estimates. Background detachment, persistent logs and Cline session/controller integration are unnecessary initially. Reuse suitable process/output helpers only after the required decision.

Command approval must be implemented before enabling the tool: show exact executable/arguments or shell text, resolved working directory, timeout and the relevant effects. Bind approval to the actual TrueForge tool-call ID and arguments. Set explicit TrueForge approval policy; MCP annotations alone are insufficient. If full arguments cannot be resolved, do not permit approval.

Confirmed API seam: `tool.approval_required` contains ToolCallRef IDs and sourceEventId references, while `model.message` exposes `toolCalls`. The current sidebar only stores IDs and shows a generic staging question. It cannot safely approve commands as-is. Use the installed SDK's contracts and correlate the referenced source event; do not guess arguments from the assistant's prose or hand-edit generated SDK files.

Commands run after the user accepts the relevant edits; never silently apply proposals so a test can run. An approved command can write independently of diff acceptance. Cancellation must terminate its process tree, but it cannot generally undo writes already performed by arbitrary commands. Re-run cancellation safety tests for command execution instead of extending the existing preview-only guarantee by assumption.

## 5. Three-file validation and completion gate

Use an isolated clean Flask 3.1.3 checkout, preserving the user's accepted Task A edit. Use the exact Task B instruction from BRIEF.md without naming candidate files or injecting known answer paths into the agent's prompt. Let TrueForge drive discovery/read/proposal/tool decisions.

The agent must find and propose a CLI implementation, a test and documentation, touching at least three files. Review the actual hunks, accept them, then approve the displayed test command and working directory. Verify `pytest tests/test_cli.py -q`, CLI help and masked configuration JSON; record actual TrueForge turns/tool calls and the final diff. Test command rejection and process cancellation separately. Do not count a mock server, hand-authored fixture or manually named three files as this live-task pass.

Proceed one tested step at a time: approved search adaptation → search validation → command import assessment and exact-argument approval UI → foreground command execution → live three-file Task B. Automatic continuation after accepting proposals needs explicit TrueForge turn handling if added; the current review queue only sends outcomes with the next user message. Do not claim a fully autonomous test-after-apply flow before it exists.
