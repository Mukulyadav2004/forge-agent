# Round 1 brief

Condensed from the supplied official TrueFoundry Forge-a-thon document
(Techfest 2026-27), checked on 9 Nov 2026. The PDF and later official
organizer clarifications take precedence. Our priorities and implementation
notes below are not extra competition rules.

Source: TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf (13 pages).
[Official portal](https://techfest.org/competitions/forge-a-thon).
PDF references: scope/models pp. 1-3; reuse p. 3; tasks/deliverables
pp. 4-6; eligibility/scoring pp. 6-9; participation/dates/rules pp. 10-12.

## Dates

- Registration closes: 15 Nov 2026
- Round 1 submission deadline: 20 Nov 2026, 23:59 IST
- Our targets, not official deadlines: implementation by 15 Nov for
  senior/teacher review; submission by 19 Nov with 20 Nov as buffer.
- Round 1 results: 30 Nov 2026
- Round 2: 16-18 Dec 2026 at Techfest, IIT Bombay (top 15 teams; includes
  raising a PR to the TrueForge repo)
- Doubts: Techfest portal, Doubt section (email is not answered).
  TrueForge questions: TrueForge Discord.
- Register through the portal and obtain a Team ID. Participants must be
  18+ on registration with a valid government/institution photo ID. Teams
  may have up to five members across institutions/organizations; each
  participant may register once and belong to only one team.

## Eligibility gate (pass or fail, checked first)

- The extension is a client of a TrueForge agent. It creates sessions and
  sends turns through the TrueForge HTTP API or TypeScript SDK, and
  renders the streamed events.
- Editor capabilities (read file, search the workspace, propose a write,
  run a command) are exposed as MCP tools. The agent, not the extension,
  decides what to read and change.
- TrueForge runs in local mode (npx @truefoundry/trueforge@latest). The
  sandbox is optional and not needed for any fixed task.
- The model is configured in TrueForge (catalog provider or
  OpenAI-compatible endpoint). The extension never calls a provider.
- The demo video briefly shows the TrueForge session for Task B (turns
  and tool calls). The repo contains the agent definition we used.
- Keeping an upstream project's own loop, or calling a provider
  directly, makes the entry ineligible.

Our development launcher currently pins TrueForge 0.184.2 for
reproducibility. That is the recorded test version, not verification of
whatever release will be latest at submission; recheck the official latest
release from a clean clone before claiming that compatibility.

## Open-source reuse

- Reuse editor-side code from Cline, Continue, Roo Code or opencode where
  suitable. Replace the upstream agent loop with TrueForge.
- Declare the upstream URL and exact source commit in the README; preserve
  licences/attribution and explain modifications and reasons.
- Judges score the delta and inspect history from the declared fork point.
  Page 6 explicitly allows "from scratch" and asks for a fork point "if any".
  A fresh repository with selected reuse still needs truthful provenance.
- A directory name or SDK/controller type import is not proof of agent-loop
  behavior. Inspect dependencies and adapt editor contracts as necessary.
- Actual reuse is recorded in ../README.md, ../THIRD_PARTY_NOTICES.md and
  CLINE-REUSE.md. Do not invent Git ancestry or inflate copied line counts.

## Five mandatory capabilities

The PDF calls these mandatory but says an entry missing a capability can
still be scored poorly on coverage. That is distinct from failing the
separate eligibility gate.

1. Inline edit: select code, press a keybinding, type an instruction;
   the proposed diff is rendered in the editor and accepted or rejected.
   A chat reply to copy and paste does not count.
2. Agent mode: one request drives a TrueForge agent through a tool loop
   (read file, search, write file, run a terminal command). It must
   change 3+ files without the user naming them.
3. Context assembly: explicit @file and @symbol mentions plus automatic
   retrieval of relevant code the user did not mention. Use TrueForge's
   context-engineering features well.
4. Diff review: hunk by hunk with a visible preview; accept or reject
   each hunk. No silent writes. An applied change must be undoable.
5. Streaming and cancellation: tokens appear as they arrive; the user can
   interrupt mid-flight; the editor never blocks; a cancelled run leaves
   no half-applied edits.

## Fixed tasks (pallets/flask tag 3.1.3, commit 22d92470)

Full commit: 22d924701a6ae2e4cd01e9a15bbaf3946094af65.
Check out the pinned tag before recording.
Exact wording will not change. Rehearse as often as needed.

### A. Inline edit (single file)

Open `src/flask/helpers.py` and select `get_debug_flag`. Give exactly:

```text
Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
```

Review and accept the diff. Verify that this prints `False`:

```sh
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
```

### B. Agent mode (3+ files, none named)

In the agent panel, with no files mentioned, give exactly:

```text
Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
```

Review and accept the hunks; show the TrueForge session. Run:

```sh
pytest tests/test_cli.py -q
```

Show it passing, then run the new command against a Flask app and show
masked JSON. The diff must touch at least three files.

### C. Resilience

Configure TrueForge with an unreachable endpoint or invalid key, then
repeat Task A. Show a responsive editor, a clear message (or automatic
takeover by a second configured model), and `git status` showing no files changed.

## Scoring (100 points)

Judges pick the anchor that fits. Between two anchors, the lower applies.
These are rubric anchors, not a score our implementation has already earned.
Totals: A = 30, B = 45, C = 25.

| Criterion | Pts | Anchors |
| --- | --- | --- |
| A1 Inline edit | 10 | 0 absent or output must be copied by hand; 4 returns an edit but no diff in the editor; 7 diff rendered, accept-all only; 10 diff rendered with per-hunk accept and reject |
| A2 Agent mode | 10 | 0 no tool loop; 4 edits a single file only; 7 edits several files but the user named them; 10 discovers and edits 3+ files unprompted (Task B) |
| A3 Streaming and cancellation | 10 | 0 editor blocks during generation; 4 streams, no cancellation; 7 cancellation works but can leave half-applied edits; 10 cancellation immediate and workspace consistent |
| B1 Context assembly | 15 | 0 whole files concatenated until the window fills; 5 explicit @-mentions only; 10 automatic retrieval, strategy stated in the write-up; 15 retrieval with a size budget, strategy stated, and visibly at work in Task B (the agent shows which files it chose and why) |
| B2 Diff safety | 10 | 0 writes to disk without showing the user; 5 full-file preview before write; 10 per-hunk review and a working undo, shown on screen |
| B3 Resilience (Task C) | 10 | 0 hang, stack trace, or files changed; 4 clear error, workspace unchanged; 7 retry with backoff, then a clear error, workspace unchanged; 10 automatic fallback to a second configured model with no user action, workspace unchanged |
| B4 TrueForge integration depth | 10 | 4 sessions and turns only, editor actions handled outside the harness; 7 editor capabilities as MCP tools, with TrueForge tool approval driving the diff review; 10 also meaningful use of at least one context-engineering feature (subagents, deferred tool loading, Code Mode, compaction) or skills, explained in the write-up and visible in the session |
| C1 Video | 10 | 0 a fixed task missing or out of order; 5 all three present but outcomes not legible or not verified; 10 all three complete, legible, verified on screen |
| C2 Write-up | 15 | 0 absent or boilerplate; 5 features without design decisions; 10 architecture, context strategy, model setup and trade-offs; 15 also an accurate scorecard with timestamps and an honest limitations section |

Process: two judges score each entry independently and the mean counts
(a spread over 15 points brings in a third judge). Top 15 are
shortlisted; ties break on B, then A, then earlier submission time.
Before the shortlist is final, each shortlisted team does a 10-minute
video call: walk through the code and repeat Task A live on a model the
organisers choose. A team that cannot explain its own submission is
replaced.

## Our reading: what earns the most next

1. B1 context assembly (15): search tool, automatic retrieval with a
   size budget, the agent showing which files it chose and why. Also
   needed for A2.
2. B2 and A1: preserve and rehearse the implemented per-hunk review and undo.
3. B3: automatic fallback to a second configured model.
4. B4: tool approval drives the diff review; use compaction, deferred
   tool loading or subagents visibly in Task B.
5. A3: cancellation leaves no half-applied edits.
6. C1 and C2 (25 points together): draft the write-up early.

## Deliverables (all public by the deadline; non-public links are not scored)

- Demo video, max 4 minutes. Screen recording with the editor visible.
  Tasks A, B, C in that order, each followed by its on-screen check, and
  the TrueForge session shown briefly during Task B. Model waiting time
  may be cut, but the PDF also says not to cut between giving an instruction
  and the diff appearing. This overlap is unresolved: ask the portal Doubt
  section before relying on such cuts. Preserve an uncut instruction-to-diff
  recording until clarified; a drafted question is not organizer approval.
- Write-up, PDF, 1 to 3 pages, eight headings in this order: 1 Team,
  2 Starting point (upstream repo and commit, or "from scratch"),
  3 Architecture on TrueForge, 4 How context is selected (strategy and
  budget), 5 Model setup (models, where they ran, approximate cost, how
  a user switches), 6 Scorecard (one row per criterion with the video
  timestamp and a one-line claim), 7 Tools used (including AI coding
  assistants; this costs no points), 8 Known limitations and what we
  would do with another month.
- GitHub repo, public. README with setup that works from a clean clone
  (including starting TrueForge locally and loading the agent
  definition), the declared fork point if any, an example model config.
  Upstream LICENSE preserved. No API keys or secrets.

## Model setups and disqualification rules

- The agent loop must run on TrueForge. No direct provider calls.
- Paid APIs, free tiers, AI gateways and existing open-source local models
  behind an OpenAI-compatible endpoint are allowed when configured in
  TrueForge. Model compatibility is a requirement to test, not a verified claim.
- All code must be the team's own, except declared forks and ordinary
  dependencies. Open-source code needs licence compliance and credit.
- Models must be declared in the write-up and configured in TrueForge.
  Hard-coding one provider is not acceptable. Must work with any model.
- No code from an employer or any private codebase.
- The repo must be public under an open-source licence compatible with
  any upstream project used.
- Plagiarism or sharing a submission between teams disqualifies all
  teams involved.
- Any AI coding tool is allowed. Declare it in the write-up.

## Out of scope (no points)

Tab completion or fill-in-the-middle; training/fine-tuning or building a
model-hosting platform; a hosted backend/database/service beyond local
TrueForge; user accounts; Marketplace publishing. Running an existing
local model is explicitly allowed. Preserve MCP authentication. Optional
build-in-public awards are separate from the 100-point technical rubric.

## Implementation facts and remaining checks (9 Nov 2026)

Verified in code or recorded checks, not new competition rules:

- propose_edit requires read_file's task-scoped base_revision, including
  ranged proposals. Edit Selection sends selected text, not a revision;
  the model must read through MCP before staging. This is intentional.
- Structured MCP reads now include source text and ranges as well as the
  revision; a live trace verified that TrueForge received the source.
- Saved text/byte verification detects changes by save participants and
  attempts rollback. A particular formatting-extension interaction is not verified.
- Architecture context has a seven-file/64,000-character cap and a file
  evidence list. It is not general relevance-ranked retrieval, a token
  budget, or a ledger explaining why each file was chosen.
- Task A's pinned baseline printed True for FLASK_DEBUG=off. One clean live
  run with configured google-gemini/gemini-3-5-flash on TrueForge 0.184.2
  passed full behavior/docstring checks, 35 helper tests and exact undo.
  Subsequent diff-row UI changes passed native editor regressions, but the
  full live Task A was not rerun after that UI adaptation. See TASK-A.md;
  one pass is not a measured reliability rate across models.

Outstanding or unverified:

- Tasks B/C and live mid-generation cancellation are not verified end to end.
- Search/symbol tools, mentions, general retrieval with selection reasons
  and token accounting, command execution and automatic fallback are not built.
- The Task B candidate paths src/flask/cli.py, tests/test_cli.py and
  docs/cli.rst exist in the pinned checkout, but no Task B implementation
  is verified. Do not pre-seed their names into the fixed instruction.
- Two aliases under the same failed provider/key may both fail. This is a
  fallback design concern, not a requirement to use two providers. Verify
  that the second configured model survives the failure used in Task C.
- TrueForge docs describe compaction at 80% of known context length by
  default, or 50,000 input tokens if unknown. No compaction event has been
  demonstrated in our agent. Consider an explicit harness threshold and
  prove it in a session before claiming B4; do not add a Cline context manager.
- TrueForge's documented skills and Code Mode require its sandbox. The
  sandbox remains optional for the fixed tasks; choose features by the
  behavior demonstrated, rather than enabling everything.
- The example model config, latest-version clean-clone setup, video,
  write-up and real timestamped scorecard still need final verification.

Technical reference: [TrueForge capabilities](https://github.com/truefoundry/trueforge/blob/main/docs/key-features/overview.mdx).
Implementation owners: ../src/agent/ForgeSession.ts,
../src/tools/EditorBridge.ts, ../src/edits/EditService.ts,
../src/context/projectContext.ts.
