# AGENTS.md

Rules for coding agents (Codex or others) working in this repository.
Read this fully before every task. For anything touching inline edit,
agent mode, context, diff review, cancellation or fallback, also read
docs/BRIEF.md (Round 1 tasks, scoring, deliverables).

## Project

Forge Agent is a VS Code extension for the TrueFoundry Forge-a-thon.
It is a client of local TrueForge. TrueForge runs the agent loop and calls
the model. The extension supplies the sidebar and the editor tools (MCP).
Official Round 1 deadline: 20 Nov 2026, 23:59 IST. Our targets are to
finish implementation by 15 Nov for review and submit by 19 Nov.

## Eligibility requirements and project safety rules

The TrueForge loop, provider boundary and licence obligations come from
the brief. Our implementation guards are project rules, not extra official gates.

- Never add a competing agent loop or call a model provider directly.
  Every model call goes through TrueForge. Keep provider credentials in
  TrueForge, never in the extension or repository.
- Never keep Cline's agent loop, provider code or SDK. No Cline package
  in package.json. Files whose job is to run the loop, call a model or
  orchestrate tool calls are not copied or adapted; read them for ideas
  only.
- A Cline editor or UI file that imports Cline types or helpers may be
  adapted if every Cline import is replaced by our own small types or a
  TrueForge event adapter. Before copying such a file, stop and report:
  what it imports, what each import is used for, and how much must
  change. Wait for my go-ahead. Do not skip it silently or copy it
  silently. Isolated search and file-operation helpers may be reused
  behind MCP tools subject to the same review and dependency rules.
- If adapting means rewriting a large part of the file or pulling in
  other Cline files, stop. Explain the trade-off (adapt, or write our
  own, with a rough size for each) and wait for my decision.
  After adapting, confirm: no Cline package imports remain, no model or
  provider calls, no loop.
- Editor capabilities are MCP tools. The agent decides what to read and
  change, not the extension.
- No silent agent-generated edits to workspace source files. Staging and
  previewing do not write them; the user accepts reviewed changes. Settings,
  logs and private recovery snapshots are not source-edit proposals.
- Preserve conflict checks, batch preflight/rollback and guarded undo.
  Separate file saves are not crash-atomic; keep that limitation honest.
- Do not weaken: workspace trust, realpath containment, secret-path
  exclusion, the loopback-only MCP server, its bearer token, Origin
  rejection.
- A model-facing tool that writes or runs commands must show its exact
  arguments, working directory and relevant effects for approval. Configure
  TrueForge approval explicitly; annotations alone are not enforcement.
  Approval to stage a preview is not acceptance to save the file.
- Runtime behavior must not depend on one provider. Never commit a real
  key or generated MCP token; clearly labelled dummy test credentials and
  example placeholders are not live secrets. Preserve upstream licences,
  attribution and the project's compatible open-source licence.
- Do not write code or prompts that depend on one model's quirks. The
  organisers may run our tasks on a model of their choice.

## How to work

1. Reuse first. Before building an editor-side feature (diffs, webview,
   keybindings, selection, search, @-mentions), look for an equivalent in the
   Cline checkout: /Users/mukulkumar/myAiCodingAssistant
   (commit 7a7878cb52fc33967d8b464b3e3d899beac42d4d). Report what you
   found before writing code. If nothing fits, say so, then build the
   smallest version. Record decisions in docs/CLINE-REUSE.md. Do not claim
   Cline universally lacks a feature based only on the files inspected.
2. One small step per turn: at most 3 files and about 150 changed lines
   (tests excluded). If it needs more, stop and propose a split.
3. Do not start the next step. Wait for me to test this one.
4. Never run git commit, push, reset, rebase or amend. I commit each
   step myself. Suggest a one-line commit message.
5. Never claim something works unless you ran the relevant check. Distinguish
   earlier recorded evidence from checks run this turn. Say "not verified"
   for live TrueForge/model paths that have not actually been exercised.
6. After each step, say what you ran and did not run. Then explain how
   the new code works in short, simple sentences. I must be able to
   explain every part in a 10-minute review call.
7. If a request conflicts with these rules, explain the conflict and wait
   for my resolution. A specific instruction explicitly changing a project
   rule is that resolution; do not ask again for permission already given.
8. If I ask a question, answer it. Do not edit files unless I ask for
   a change.
9. Borrowed code: keep copying and adaptation separately reviewable, ideally
   in separate steps. New borrowed files need a header with upstream path,
   exact commit and licence, plus third-party notes and README updates.
   Do not put a raw copy with unresolved imports into active source or keep
   unused copies just to count reuse. If buildability, provenance updates
   or the step-size limit conflict, explain and propose a split first.
10. After each step, add two lines to docs/STEP-NOTES.md: what changed
    and why.
11. Do not rewrite or reformat code you were not asked to touch.
12. New tools return bounded output with explicit limits and are exercised
    through real editor/MCP execution before being called verified. State
    separately whether live TrueForge/model integration was tested.
13. Before calling a step done, run pnpm run check and relevant tests. Use
    package scripts; add a script for a missing repeatable workflow. Explain
    when no executable test applies to a docs-only change.

## Commands

Run these from `/Users/mukulkumar/forge-agent`:

```sh
pnpm run dev
pnpm run check
pnpm run test:edits
pnpm run test:integration
pnpm run test:smoke
pnpm run test
```

`dev` opens the Extension Development Host.
Task A rehearsal: docs/TASK-A.md. The trueforge:local script pins 0.184.2;
the brief specifies @latest. A latest-version clean-clone check is pending.
Do not replace the esbuild bundling with plain tsc. The pinned TrueForge
SDK's CommonJS entry fails to load directly.

## Code map

```text
src/extension.ts               commands and startup
src/shared/messages.ts         sidebar <-> extension message contracts
src/sidebar/, src/webview/     sidebar and webview UI
src/agent/ForgeSession.ts      TrueForge SDK boundary, agent definition
src/agent/instructions.ts      the agent's system prompt (our own words;
                               never copy Cline's prompt text)
src/tools/EditorBridge.ts      MCP tools: list_files, read_file,
                               propose_edit
src/edits/review.ts            review schemas
src/edits/EditService.ts       proposals, transactions, undo
src/edits/lineChanges.ts       bounded local hunk computation
src/context/projectContext.ts bounded architecture context
src/workspace/WorkspaceFiles.ts workspace/file safety
src/editor/ClineEditPreview.ts diff preview adapted from Cline (Apache-2.0)
src/webview/ClineDiffLines.ts   review rows adapted from Cline
docs/BRIEF.md                  Round 1 tasks, scoring, deliverables
docs/STEP-NOTES.md             what changed and why, per step
docs/NOV-4-5-HANDOFF.md        earlier handoff notes
```

## Status (9 Nov 2026; verify before assuming)

Built: TrueForge sessions, streaming, approve/deny, cancel request, New Task;
Edit Selection; list_files, read_file with source/revision, whole-file and
ranged propose_edit; per-hunk and batch review; guarded apply/save/undo;
Cline-derived native previews and diff rows. Architecture requests have a
seven-file/64,000-character cap and a file-evidence list; this is not a
general retrieval/context ledger or a token budget.

Recorded evidence: one clean live Task A pass with configured model
google-gemini/gemini-3-5-flash, complete docstring coverage, 35 passing
Flask helper tests and exact undo to a clean rehearsal tree. Subsequent
diff-row presentation changes passed native editor regressions, but the
full live Task A was not rerun after that presentation adaptation.
See docs/TASK-A.md and its recorded evidence; one pass is not a reliability rate.

Not built: search/symbol tools, @file/@symbol mentions, query-driven
retrieval with selection reasons/token accounting, command execution,
file create/delete/rename, automatic model fallback, scout subagents,
persistent conversation/undo history. Not verified end to end: Tasks B/C,
live mid-generation cancellation, broad model compatibility and the final
latest-version clean-clone run. Update status with evidence.

## Team

Two people. Intended split: one owns src/agent and TrueForge/MCP integration;
the other owns src/sidebar, src/webview and proposal review. Named owners
are not recorded yet. Announce scope before changing shared contracts or
the other person's area; do not infer an extra permission gate.

## Out of scope (no points)

Tab completion, training/fine-tuning or a model-hosting platform, hosted
backends, user accounts and Marketplace publishing earn no Round 1 technical
points. Serving an existing local model is explicitly allowed. The TrueForge
sandbox is optional; do not make fixed tasks depend on it or build sandbox
infrastructure unless I request it. Preserve MCP authentication.
