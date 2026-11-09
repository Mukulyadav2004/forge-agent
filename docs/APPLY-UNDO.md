# Reviewed apply and undo

`EditService` is the canonical owner of read receipts, staged proposals, transaction state, and the undo stack. `VscodeEditBackend` adapts its storage/editor operations. `WorkspaceFiles` owns path containment, UTF-8 checks, physical file identity, and editor alias checks. `ClineEditPreview` supplies the adapted preview store and exact-tab lifecycle. Review schemas are owned by `src/edits/review.ts`; the webview receives IDs and bounded excerpts. Review actions send proposal/hunk IDs, never replacement content.

## Flow

1. `read_file` captures a file revision and returns an opaque receipt tied to the active task.
2. `propose_edit` validates that receipt against current disk/editor state. Dirty files, stale receipts, cancelled tasks, and changed files cannot stage an applicable proposal.
3. The Cline-derived adapter opens two virtual documents; the real file is unchanged.
4. User acceptance preflights every selected file. One conflict prevents the whole selected batch from being edited.
5. Original bytes are backed up outside the project. One text-only `WorkspaceEdit` changes editor buffers; affected documents are saved and verified.
6. On failure, rollback restores files only while their states are still owned by this operation. A newer writer is preserved, and incomplete recovery blocks further writes in this extension host.
7. Undo preflights the saved after-state of the last batch, then restores its original bytes as another guarded transaction.

## Per-hunk review and ranged proposals

`propose_edit` optionally accepts inclusive `start_line` and `end_line`. The host replaces those complete lines against the verified snapshot, preserves all surrounding code, and retains a following line boundary for non-empty replacements. Supplying neither range field retains whole-file replacement behavior. A read revision is required in both cases.

`lineChanges.ts` uses `diff@8.0.2` for line comparison, with a 150 ms / 2,000-edit-distance limit and at most 200 hunks. Adjacent removed/added lines form one hunk; unchanged lines separate hunks. Full text stays in the host, while each removed/added excerpt sent to the webview is capped at 6,000 characters. The native preview remains the complete diff.

Accept hunk commits and saves that hunk immediately using the same preflight, backup, verification and rollback path as batch apply. The service refreshes the expected snapshot before another acceptance. Rejected hunks retain their original text even when other hunks are accepted or Apply all is used. Later manual changes invalidate remaining acceptance.

Each hunk acceptance is one undo batch. Undo restores that batch and discards remaining pending hunks for its proposal, rather than trying to reapply them against an old revision. Earlier applied batches remain independently undoable, including when edits to other files were interleaved.

## Guarantees and boundaries

- Existing regular UTF-8 files only, with BOM and CRLF preservation. No file create/delete/rename operations.
- Both disk bytes and editor versions matter. Real paths enforce workspace containment; original editor URIs preserve alias/unsaved-buffer identity.
- Apply/undo are serialized and unavailable while the agent is running or a tool approval is pending.
- Model tools can stage proposals but cannot accept them. The user sends only proposal IDs to the host.
- New Task/cancellation invalidate pending read receipts and proposals; opening or closing previews never changes the real file.
- Atomic editor text replacement does not make separate filesystem saves crash-atomic. Rollback and private snapshots cover recoverable failures; a crash, a persistent storage failure, or another writer can require manual recovery.
- Save participants are not bypassed. If they change the accepted content, verification fails rather than silently accepting a different diff.
- Ten undo batches are retained in memory. Recovery snapshots remain on disk; automatic replay/recovery after restart is not implemented.

## Verification

`pnpm run test:edits` exercises preview/reject safety, stale and dirty reads, multi-file conflicts, batch apply/undo, later manual edits, save failure rollback, persistent recovery failure, concurrent writes, editor rejection, cancellation, duplicate acceptance, BOM/CRLF, successive undo, supersession, and snapshot-storage failure.

`pnpm run test:smoke` exercises the actual VS Code editor, webview, MCP tools, Cline-derived preview behavior, multi-file saves, conflict refusal, dirty aliases, undo, and snapshot permissions in an isolated workspace/profile. No user project is edited by these checks.

`pnpm run test:task-a` exercises inline selection, ranged staging, per-hunk acceptance, Python verification, Flask helper tests and exact undo on a pinned rehearsal checkout. Without `--model`, it supplies a deterministic fixture; with `--model provider/model`, it runs through local TrueForge. Agent command execution remains a subsequent milestone.
