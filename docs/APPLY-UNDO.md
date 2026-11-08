# Reviewed apply and undo

`EditService` is the canonical owner of read receipts, staged proposals, transaction state, and the undo stack. `VscodeEditBackend` adapts its storage/editor operations. `WorkspaceFiles` owns path containment, UTF-8 checks, physical file identity, and editor alias checks. `ClineEditPreview` supplies the adapted preview store and exact-tab lifecycle. Review schemas are owned by `src/edits/review.ts`; the webview receives IDs and summaries, not writeable paths/content contracts.

## Flow

1. `read_file` captures a file revision and returns an opaque receipt tied to the active task.
2. `propose_edit` validates that receipt against current disk/editor state. Dirty files, stale receipts, cancelled tasks, and changed files cannot stage an applicable proposal.
3. The Cline-derived adapter opens two virtual documents; the real file is unchanged.
4. User acceptance preflights every selected file. One conflict prevents the whole selected batch from being edited.
5. Original bytes are backed up outside the project. One text-only `WorkspaceEdit` changes editor buffers; affected documents are saved and verified.
6. On failure, rollback restores files only while their states are still owned by this operation. A newer writer is preserved, and incomplete recovery blocks further writes in this extension host.
7. Undo preflights the saved after-state of the last batch, then restores its original bytes as another guarded transaction.

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

Per-hunk review, model-driven coding-task evaluation, and shell/test execution are subsequent milestones.
