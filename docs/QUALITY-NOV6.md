# Architecture response quality review — November 6

## Observed problem

The original DreamGym session listed files and read only `ARCHITECTURE.md` before returning an architecture response. Its trace also called `get_openui_instructions`; Generative UI was enabled by the harness default, while the extension displayed plain text. The proposed complexity chart had no supporting measurements.

## Implemented changes

- Disable unsupported harness interactions explicitly, including OpenUI.
- Require implementation evidence, source links, clear uncertainty, and distinctions between actual behavior and plans in the canonical agent instructions.
- Supply bounded source context for architecture requests: up to seven source files across directories, within 64,000 characters. Larger files have explicit excerpt boundaries and symbol outlines. This is deterministic context preparation, not a model or tool execution loop.
- Show file ranges supplied as context separately from successful MCP file reads.
- Render sanitized Markdown, tables, and Mermaid. Keep user text literal, reject generated HTML/images, and open source links through workspace containment checks.
- Preserve individual assistant message IDs during streaming instead of merging separate model messages into one response.

## Verification

TypeScript and SDK/context integration checks pass. The actual VS Code smoke checks cover visible diagram labels, tables, raw-HTML safety, source-link navigation, evidence display, and delivery of architecture context to the session.

A real Flash Lite architecture request received source excerpts from seven DreamGym modules and returned Mermaid plus source links without OpenUI. In that run, it made no additional `read_file` calls. The evaluation records supplied context and tool reads separately; file-count/format checks are not semantic verification.

## Reasoning remains a limitation

Manual review still found errors in the Flash Lite output:

- It attributed initial data collection to `RLTrainer`, although `seed_real_episodes` is implemented in `experiments/run_experiments.py`.
- It described the policy updates as gradients, although `SimplePolicy.update` adjusts dictionary weights using a reward-based expression. Its action selection remains heuristic.
- An earlier, smaller-context run wrongly called `SimplePolicy.update` empty after seeing a truncated excerpt. The context budget and explicit boundary guidance were changed in response.

The configured Pro model could not be evaluated: Google returned a 429 with a zero free-tier quota for that model. The configured Flash alias timed out. The user's default model was not changed.

## Next acceptance target

November 9 transport finding: `read_file` previously placed source text only in MCP text content, while its structured result contained just `base_revision`. TrueForge prefers structured content, so those tool reads did not actually supply the source text to the model. The structured result now includes bounded source text, path and line ranges; native MCP regression checks and the live Task A trace verify that contract. Earlier analysis-quality findings remain observations, but cannot be attributed solely to the model without reevaluation after this fix.

Complete a real coding task with relevant source inspection, an approved proposed change, executable tests, and undo. Evaluate reasoning on known repository facts and tasks, rather than treating a polished diagram or a minimum file count as proof of correctness. Applying and undoing reviewed existing-file edits were implemented on November 8; per-hunk review and ranged proposals were added on November 9. Agent command execution remains unfinished. See `TASK-A.md` for the pinned coding-task rehearsal and its fixture/live distinction.

Task A now has one clean live pass on November 9 with `google-gemini/gemini-3-5-flash`, complete docstring coverage, 35 passing Flask helper tests and exact undo. Earlier Lite attempts omitted the empty-string documentation case; another Flash run hit a 429 after producing a correct proposal. Do not infer general model reliability from the single clean pass.
