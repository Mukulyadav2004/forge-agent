import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as vscode from 'vscode';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Frame } from 'playwright-core';

/**
 * A file saved through the real approve-and-save path, then changed and reverted by commands: Forge must notice both
 * in the run_command result and in the activity feed, because the checklist follows the disk, not the history of saves.
 * A fake TrueForge streams one propose_edit call and pauses on its approval; the test clicks Approve in the sidebar.
 */
export async function checkDiskTruth(options: { client: Client; frame: Frame }): Promise<void> {
  const { client, frame } = options;
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root);
  const path = 'disk-truth.txt';
  const uri = vscode.Uri.joinPath(root.uri, path);
  const text = async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('before\n'));
  const probe = vscode.Uri.joinPath(root.uri, 'mention_probe.py');
  await vscode.workspace.fs.writeFile(probe, new TextEncoder().encode('import os\n\n@decorated\ndef mention_target(value):\n    return value\n\n\nother = 1\n'));
  const read = await client.callTool({ name: 'read_file', arguments: { path } });
  const revision = (read.structuredContent as { base_revision: string }).base_revision;
  const editArguments = JSON.stringify({ path, base_revision: revision, start_line: 1, end_line: 1, new_text: 'after\n', explanation: 'Disk truth check' });
  let decisions: unknown[] = [];
  let sent = '';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { manifest?: { name: string }; events?: unknown[]; input?: { content?: unknown }[] };
    if (Array.isArray(body.input)) sent += body.input.map(event => String(event.content ?? '')).join('\n');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/settings/mcp-servers') { response.end(JSON.stringify({ data: { name: body.manifest?.name, manifest: body.manifest, auth_status: { status: 'authenticated' } } })); return; }
    if (request.url === '/api/v1/sessions') { response.end(JSON.stringify({ data: { id: 'disk-truth-session' } })); return; }
    const write = (event: Record<string, unknown>) => response.write(`data: ${JSON.stringify({ created_at: new Date().toISOString(), thread_id: 'main', ...event })}\n\n`);
    if (request.url?.endsWith('/events')) {
      decisions = body.events ?? [];
      response.end(JSON.stringify({ data: decisions.map((event, i) => ({ ...event as object, id: `decision-${i}`, created_at: new Date().toISOString() })) })); return;
    }
    response.setHeader('Content-Type', 'text/event-stream');
    if (request.url?.includes('/subscribe')) {
      for (const [i, event] of decisions.entries()) write({ ...event as object, id: `decision-${i}` });
      write({ type: 'model.message.delta', id: 'resumed', content: 'Disk truth resumed' });
      write({ type: 'turn.done', id: 'done', thread_id: null, state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } });
      response.end(); return;
    }
    write({ type: 'turn.created', id: 'created', turn_id: 'disk-truth-turn', previous_turn_id: null, thread_id: null, state: { status: 'running' } });
    write({ type: 'model.message', id: 'model-edit', tool_calls: [{ id: 'edit-1', type: 'function', function: { name: 'propose_edit', arguments: editArguments }, tool_info: { type: 'mcp', name: 'propose_edit', server_id: 'editor', server_name: 'editor' } }] });
    write({ type: 'tool.approval_required', id: 'ask-edit', tool_calls: [{ id: 'edit-1', source_event_id: 'model-edit' }] });
    write({ type: 'turn.update', id: 'paused', state: { status: 'paused' } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = vscode.workspace.getConfiguration('forgeAgent');
  const previous = { baseUrl: config.inspect('baseUrl')?.workspaceValue, model: config.inspect('model')?.workspaceValue };
  try {
    await config.update('baseUrl', `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Workspace);
    await config.update('model', 'test/disk-truth', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('forgeAgent.newTask');
    await frame.getByRole('textbox', { name: 'Message', exact: true }).fill('Disk truth check with @disk-truth.txt and @mention_target, not a@b.com');
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    await frame.locator('#approve-button:not([disabled])').waitFor();
    await frame.locator('#approve-button').click();
    await frame.getByRole('log').getByText('Disk truth resumed', { exact: true }).waitFor();
    await frame.locator('#message-input:not([disabled])').waitFor();
    assert.equal(await text(), 'after\n', 'Approve saved the reviewed edit.');
    // @-mentions: the file and the definition were attached to the request and shown in the feed.
    assert.match(sent, /Mentioned by the user \(attached by Forge\):\n\nFile: disk-truth\.txt \(@disk-truth\.txt\), lines 1-1, base_revision [\w-]+\.\n1: before/u);
    assert.match(sent, /File: mention_probe\.py \(@mention_target\), lines 3-5, base_revision [\w-]+\.\n3: @decorated\n4: def mention_target\(value\):\n5:     return value$/u);
    assert.doesNotMatch(sent, /@b\.com:/u, 'An e-mail address is not a mention.');
    await frame.locator('#messages').getByText('mention_probe.py:3-5', { exact: true }).first().waitFor();
    // The saved lines shown in the result count as read, so the next line edit needs no new read and no base_revision.
    const next = await client.callTool({ name: 'propose_edit', arguments: { path, insert_line: 2, new_text: 'tail\n', explanation: 'Edit after a save' } });
    assert.equal(next.isError, undefined, `Lines shown after a save count as read: ${JSON.stringify(next.content)}`);
    await vscode.commands.executeCommand('forgeAgent.rejectAll');

    const run = async (command: string) => {
      const result = await client.callTool({ name: 'run_command', arguments: { command, reason: 'Disk truth check' } });
      assert.equal(result.isError, undefined);
      return (result.structuredContent as { hint?: string }).hint ?? '';
    };
    assert.doesNotMatch(await run('echo untouched'), /were changed by this command/u, 'A command that leaves saved files alone adds no note.');
    assert.match(await run(`printf 'other\\n' > ${path}`), /disk-truth\.txt was changed by this command after your last save\. Read it again/u);
    assert.match(await run(`printf 'before\\n' > ${path}`), /disk-truth\.txt is back to how it was before this request: your saved changes to it are gone\./u);
    assert.doesNotMatch(await run('echo again'), /disk-truth/u, 'A reverted file is reported once, then no longer tracked.');
    await frame.locator('#messages').getByText('reverted by a command · your saved changes are gone').waitFor();
  } finally {
    // Later checks start their own sessions; leave a fresh chat like the other checks do.
    await vscode.commands.executeCommand('forgeAgent.newTask');
    await config.update('baseUrl', previous.baseUrl, vscode.ConfigurationTarget.Workspace);
    await config.update('model', previous.model, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
    await vscode.workspace.fs.delete(probe).then(undefined, () => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
