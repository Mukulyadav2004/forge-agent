# Fixed Task A rehearsal

Use Flask tag `3.1.3`, commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. A clean checkout prints `True` for `FLASK_DEBUG=off`; the accepted change must print `False`.

## Prepare and open

From the Forge Agent repository:

```sh
# Keep this running in a separate terminal:
pnpm run trueforge:local
# Then, in another terminal:
pnpm run task:a:prepare
pnpm run task:a:open
```

This creates an isolated checkout at `out-test/task-a/flask` and a sibling Python environment at `out-test/task-a/venv`. Another Flask checkout is left untouched. Preparation refuses to reset an existing checkout with changes. Pytest is pinned to 8.4.2 because Flask 3.1.3's fixtures use `monkeypatch.notset`, which is absent from the tested pytest 9.2 installation.

`task:a:open` builds the extension and opens that checkout in an Extension Development Host, with `src/flask/helpers.py` at `get_debug_flag`.

`trueforge:local` pins TrueForge 0.184.2 and allows the editor's loopback MCP connection. It refuses to start on an occupied port. If the running server reports `Outbound URL blocked for host "127.0.0.1"`, stop that older server and start this command; changing an unrelated checkout's `.env` does not change a running process.

## Give the agent the exact instruction

1. Keep local TrueForge running with a configured model. Select it through Forge's model picker.
2. Run **Forge: New Task** after loading the updated extension.
3. Select the complete `get_debug_flag` function.
4. Run **Forge: Edit Selection** or press **Command + Option + F**.
5. Enter exactly:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Allow TrueForge's preview request. The proposed changes must appear in the native diff and **Review changes**; staging must leave the file unchanged. Inspect the docstring and behavior changes. Use **Accept hunk** for each desired hunk. Use **Reject hunk** only for changes you do not want; rejecting a required part means the task is incomplete until a corrected proposal is accepted.

Hunk boundaries depend on the proposed text. The number of hunks is not a success criterion. The docstring should cover unset/empty values and all explicit false strings, including the existing `0`, `false`, `no` and the requested `off`, `n` values.

## Verify on screen

In the development window's terminal, from the rehearsal Flask folder:

```sh
source ../venv/bin/activate
git rev-parse --short=8 HEAD
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
pytest tests/test_helpers.py -q
git diff -- src/flask/helpers.py
```

The commit must be `22d92470`, the command must print `False`, and the helper tests must pass. Check that only the intended function changed and its docstring is accurate. From the extension repository, `pnpm run task:a:verify` also checks case variants, previous false values, true values and the unset case.

Use **Undo last apply** once per accepted hunk, or once if you used Apply file/all. Show the restored code and `git status --short`. Do this before reloading: the undo stack currently lives in the extension host's memory. After undoing part of a proposal, remaining pending hunks are discarded; ask for a fresh proposal to continue editing.

## Automated checks

```sh
# No model call; a fixed proposal tests the real editor and Python behavior.
pnpm run test:task-a
# Real inline command, SDK session, TrueForge tool calls and approvals.
pnpm run test:task-a --model google-gemini/gemini-3-5-flash
# Optional, only for a model that supports this reasoning level:
pnpm run test:task-a --model google-gemini/gemini-3-1-flash-lite --reasoning-effort medium
```

Both modes require the prepared, clean rehearsal checkout. Reports and screenshots are under `out-test/task-a/`; their `mode` field distinguishes fixture validation from a real model run. A fixture pass is not a model evaluation or a hackathon demonstration. On success, accepted changes are undone and the checkout is clean. On failure, the test attempts guarded undo and records whether cleanup succeeded; it does not force-reset files.

For manual use, **Forge Agent: Reasoning Effort** optionally forwards a supported level through TrueForge; leave it empty for the provider default. Start a new task after changing it. The live report records the level used. The live test also checks the persisted TrueForge trace for actual source text, and removes its temporary editor connector after the test window closes. Session history remains available for inspection.

Google can return a 429 even after a correct proposal was staged. Follow the provider's retry delay before another rehearsal. A verified change with an errored final model turn is recorded separately from a clean live pass.

The extension has no command-execution tool yet. The verification commands run in the terminal or the test harness, not autonomously inside Forge Agent.

## November 9 evidence

- One clean live run passed with configured model `google-gemini/gemini-3-5-flash`, provider-default reasoning, and TrueForge 0.184.2.
- Session: `01m6zmts16bp26ds5g0jnhdhhh`. It made two bounded reads of `src/flask/helpers.py` and one ranged proposal. The final turn completed with status `done`.
- Two hunks were accepted independently. The exact `FLASK_DEBUG=off` command printed `False`; the false/true/unset matrix and docstring coverage passed; all 35 `tests/test_helpers.py` tests passed. Undo restored the original bytes and a clean Git tree.
- This is one clean pass, not a measured reliability rate. Earlier Flash Lite runs repeatedly omitted the empty-string documentation case. Another Flash run produced a correct proposal but ended with a provider 429 after further exploration; it is not counted as a clean pass.
- Live traces exposed and verified the fix for structured MCP reads: the model now receives source text as well as the base revision. Model/provider quotas still apply. No default user model was changed by the isolated checks.

Current reports: `out-test/task-a/live-result.json` and `out-test/task-a/editor-result.json`. They are ignored artifacts, not committed model-generated changes to Flask.
