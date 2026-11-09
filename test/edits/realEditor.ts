// Focus-preserving preview coverage adapted from Cline's VscodeEditPreview.test.ts (Apache-2.0).
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Frame } from 'playwright-core';

export async function checkEditorTransactions(options: { client: Client; frame: Frame; extensionUri: vscode.Uri }): Promise<void> {
  const { client, frame } = options;
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error('Open the smoke workspace.');
  const rootUri = root.uri;
  const panel = frame.getByRole('region', { name: 'Proposed changes', exact: true });
  const message = panel.getByRole('status');
  const disk = async (path: string): Promise<string> => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, path)));
  async function edit(options: { path: string; text: string; save: boolean; uri?: vscode.Uri }): Promise<void> {
    const document = await vscode.workspace.openTextDocument(options.uri ?? vscode.Uri.joinPath(rootUri, options.path));
    const changes = new vscode.WorkspaceEdit();
    changes.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), options.text);
    assert.equal(await vscode.workspace.applyEdit(changes), true);
    if (options.save) assert.equal(await document.save(), true);
  }
  async function stage(options: { path: string; text: string }): Promise<string> {
    const read = await client.callTool({ name: 'read_file', arguments: { path: options.path } });
    const readData: unknown = read.structuredContent;
    if (typeof readData !== 'object' || readData === null || !('base_revision' in readData) || typeof readData.base_revision !== 'string') throw new Error('read_file did not return base_revision.');
    const revision = readData.base_revision;
    const result = await client.callTool({ name: 'propose_edit', arguments: { path: options.path, base_revision: revision, new_text: options.text, explanation: 'Native editor transaction check' } });
    const proposalData: unknown = result.structuredContent;
    if (result.isError || typeof proposalData !== 'object' || proposalData === null || !('proposal_id' in proposalData) || typeof proposalData.proposal_id !== 'string') throw new Error(`Could not stage ${options.path}: ${JSON.stringify(result)}`);
    const id = proposalData.proposal_id;
    await frame.locator(`[data-proposal-id="${id}"]`).waitFor();
    return id;
  }
  const row = (id: string) => panel.locator(`[data-proposal-id="${id}"]`);
  function diffTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'forge-edit-preview');
  }
  const original = { 'example.txt': 'original text\n', 'second.txt': 'original second\n', 'third.txt': 'original third λ\r\n' };
  const originalBytes = new Map<string, Uint8Array>();
  for (const path of Object.keys(original)) originalBytes.set(path, await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, path)));
  await vscode.commands.executeCommand('forgeAgent.rejectAll');
  const hunkOriginal = 'header\n    one\nseparator\ntwo\nfooter\n';
  await edit({ path: 'example.txt', text: hunkOriginal, save: true });
  const hunkProposal = await stage({ path: 'example.txt', text: 'header\n    ONE\n\tinserted <img src=x>\nseparator\nTWO\nfooter\n' });
  const hunkRows = row(hunkProposal).locator('.hunk-row');
  assert.equal(await hunkRows.count(), 2);
  assert.deepEqual(await hunkRows.nth(0).locator('.cline-diff-code').allTextContents(), ['    one', '    ONE', '\tinserted <img src=x>']);
  assert.deepEqual(await hunkRows.nth(0).locator('.cline-diff-number').allTextContents(), ['2', '2', '3']);
  assert.deepEqual(await hunkRows.nth(0).locator('.cline-diff-prefix').allTextContents(), ['-', '+', '+']);
  assert.equal(await hunkRows.locator('img').count(), 0);
  await hunkRows.nth(1).getByRole('button', { name: 'Reject hunk', exact: true }).click();
  await message.filter({ hasText: 'Rejected this hunk' }).waitFor();
  assert.equal(await disk('example.txt'), hunkOriginal);
  assert.deepEqual(await hunkRows.nth(0).locator('.cline-diff-number').allTextContents(), ['', '', '']);
  await hunkRows.nth(0).getByRole('button', { name: 'Accept hunk', exact: true }).click();
  await message.filter({ hasText: 'Accepted and saved this hunk' }).waitFor();
  assert.equal(await disk('example.txt'), 'header\n    ONE\n\tinserted <img src=x>\nseparator\ntwo\nfooter\n');
  await panel.screenshot({ path: vscode.Uri.joinPath(options.extensionUri, 'out-test', 'edit-hunks.png').fsPath });
  await panel.getByRole('button', { name: 'Undo last apply', exact: true }).click();
  await message.filter({ hasText: 'Undid the last applied batch' }).waitFor();
  assert.equal(await disk('example.txt'), hunkOriginal);
  await edit({ path: 'example.txt', text: original['example.txt'], save: true });
  await frame.getByRole('textbox', { name: 'Message', exact: true }).focus();
  for (const [path, text] of Object.entries(original)) await stage({ path, text: `changed ${text}` });
  assert.equal(await frame.getByRole('textbox', { name: 'Message', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(diffTabs().length, 3);
  for (const [path, text] of Object.entries(original)) assert.equal(await disk(path), text);

  await edit({ path: 'second.txt', text: 'manual saved change\n', save: true });
  await panel.getByRole('button', { name: 'Apply all', exact: true }).click();
  await message.filter({ hasText: 'changed since the proposal' }).waitFor();
  assert.equal(await disk('example.txt'), original['example.txt']);
  assert.equal(await disk('third.txt'), original['third.txt']);
  assert.equal(await disk('second.txt'), 'manual saved change\n');
  await panel.getByRole('button', { name: 'Reject all', exact: true }).click();
  await edit({ path: 'second.txt', text: original['second.txt'], save: true });

  for (const [path, text] of Object.entries(original)) await stage({ path, text: `changed ${text}` });
  await panel.getByRole('button', { name: 'Apply all', exact: true }).click();
  await message.filter({ hasText: 'Applied and saved 3 file(s)' }).waitFor();
  for (const [path, text] of Object.entries(original)) {
    assert.equal(await disk(path), `changed ${text}`);
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, path))).isDirty, false);
  }
  await panel.getByRole('button', { name: 'Undo last apply', exact: true }).click();
  await message.filter({ hasText: 'Undid the last applied batch (3 file(s))' }).waitFor();
  for (const [path, text] of Object.entries(original)) assert.equal(await disk(path), text);
  for (const path of Object.keys(original)) assert.deepEqual(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, path)), originalBytes.get(path));

  const dirtyId = await stage({ path: 'example.txt', text: 'must not replace dirty work\n' });
  const aliasUri = vscode.Uri.file(await realpath(vscode.Uri.joinPath(rootUri, 'example.txt').fsPath));
  await edit({ path: 'example.txt', uri: aliasUri, text: 'unsaved user work\n', save: false });
  await row(dirtyId).getByRole('button', { name: 'Apply file', exact: true }).click();
  await message.filter({ hasText: 'changed since the proposal' }).waitFor();
  assert.equal((await vscode.workspace.openTextDocument(aliasUri)).getText(), 'unsaved user work\n');
  assert.equal(await disk('example.txt'), original['example.txt']);
  await panel.getByRole('button', { name: 'Reject all', exact: true }).click();
  await edit({ path: 'example.txt', uri: aliasUri, text: original['example.txt'], save: true });

  const accepted = await stage({ path: 'example.txt', text: 'accepted change\n' });
  await row(accepted).getByRole('button', { name: 'Apply file', exact: true }).click();
  await message.filter({ hasText: 'Applied and saved 1 file(s)' }).waitFor();
  const realDocument = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, 'example.txt'));
  await vscode.window.showTextDocument(realDocument, { preview: false });
  const second = await stage({ path: 'example.txt', text: 'second pending change\n' });
  await row(accepted).getByRole('button', { name: 'Preview', exact: true }).click();
  const tabDeadline = Date.now() + 5_000;
  while (diffTabs().length !== 2 && Date.now() < tabDeadline) await setTimeout(100);
  assert.equal(diffTabs().length, 2);
  await row(second).getByRole('button', { name: 'Reject', exact: true }).click();
  const closeDeadline = Date.now() + 5_000;
  while (diffTabs().length !== 1 && Date.now() < closeDeadline) await setTimeout(100);
  assert.equal(diffTabs().length, 1);
  assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === realDocument.uri.toString()));
  assert.equal(await disk('example.txt'), 'accepted change\n');

  await edit({ path: 'example.txt', text: 'later manual work\n', save: true });
  await panel.getByRole('button', { name: 'Undo last apply', exact: true }).click();
  await frame.locator('#status').filter({ hasText: 'preserve your edits' }).waitFor();
  assert.equal(await disk('example.txt'), 'later manual work\n');
  await panel.screenshot({ path: vscode.Uri.joinPath(options.extensionUri, 'out-test', 'edit-review.png').fsPath });
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(options.extensionUri, 'out-test', 'edit-result.json'), new TextEncoder().encode(JSON.stringify({ native_batch_apply: true, exact_batch_undo: true, conflict_blocks_batch: true, dirty_buffer_preserved: true, later_edits_preserved: true, cline_preview_focus: true, independent_preview_cleanup: true, per_hunk_accept_reject_undo: true })));
}
