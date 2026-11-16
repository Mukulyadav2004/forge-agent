import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as vscode from 'vscode';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Frame } from 'playwright-core';

export async function checkReviewFeedback(options: { client: Client; frame: Frame; extensionUri: vscode.Uri }): Promise<void> {
  const { client, frame } = options;
  const turns: { path: string; text: string[] }[] = [];
  let sessions = 0;
  let failNext = false;
  let approvalMode = false, resumes = 0;
  const approvalRequests: { path: string; events: unknown[] }[] = [];
  let decisions: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/settings/mcp-servers') {
      assert.ok(typeof body === 'object' && body !== null && 'manifest' in body);
      const manifest = body.manifest;
      assert.ok(typeof manifest === 'object' && manifest !== null && 'name' in manifest);
      response.end(JSON.stringify({ data: { name: manifest.name, manifest, auth_status: { status: 'authenticated' } } })); return;
    }
    if (request.url === '/api/v1/sessions') {
      response.end(JSON.stringify({ data: { id: `feedback-session-${++sessions}` } })); return;
    }
    const write = (event: Record<string, unknown>) => response.write(`data: ${JSON.stringify({ created_at: new Date().toISOString(), thread_id: null, ...event })}\n\n`);
    if (approvalMode && request.url?.endsWith('/events')) {
      assert.ok(typeof body === 'object' && body !== null && 'events' in body && Array.isArray(body.events));
      approvalRequests.push({ path: request.url, events: body.events });
      if (failNext) { failNext = false; response.writeHead(503).end(JSON.stringify({ error: { message: 'Feedback fixture temporary failure' } })); return; }
      decisions = body.events;
      response.end(JSON.stringify({ data: decisions.map((event, i) => ({ ...event as object, id: `decision-${i}`, created_at: new Date().toISOString() })) })); return;
    }
    if (approvalMode && request.url?.includes('/subscribe')) {
      assert.equal(request.url, `/api/v1/sessions/feedback-session-${sessions}/turns/feedback-turn-${turns.length}/subscribe?after_event_id=approval-paused-${turns.length}`);
      response.setHeader('Content-Type', 'text/event-stream');
      for (const [i, event] of decisions.entries()) write({ ...event as object, id: `decision-${i}` });
      write({ type: 'turn.update', id: 'running', state: { status: 'running' } });
      write({ type: 'model.message.delta', id: `resumed-${++resumes}`, thread_id: 'main', content: `Approval resumed ${resumes}` });
      write({ type: 'turn.done', id: 'done', state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } });
      response.end(); return;
    }
    assert.ok(typeof body === 'object' && body !== null && 'input' in body && Array.isArray(body.input));
    const text = body.input.map((event: unknown) => {
      assert.ok(typeof event === 'object' && event !== null && 'type' in event && event.type === 'user.message' && 'content' in event && typeof event.content === 'string');
      return event.content;
    });
    turns.push({ path: request.url ?? '', text });
    if (failNext) { failNext = false; response.writeHead(503).end(JSON.stringify({ error: { message: 'Feedback fixture temporary failure' } })); return; }
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ type: 'turn.created', id: `created-${turns.length}`, turn_id: `feedback-turn-${turns.length}`, previous_turn_id: null, thread_id: null, created_at: new Date().toISOString(), state: { status: 'running' } })}\n\n`);
    if (approvalMode) {
      for (const id of ['one', 'two']) write({ type: 'tool.approval_required', id: `ask-${id}`, thread_id: 'main', tool_calls: [{ id, source_event_id: 'model-call' }] });
      write({ type: 'turn.update', id: `approval-paused-${turns.length}`, state: { status: 'paused' } });
      return;
    }
    response.end(`data: ${JSON.stringify({ type: 'model.message.delta', id: `feedback-${turns.length}`, thread_id: 'main', content: `Review feedback response ${turns.length}` })}\n\ndata: ${JSON.stringify({ type: 'turn.done', id: `done-${turns.length}`, thread_id: null, created_at: new Date().toISOString(), state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root);
  const path = 'feedback.txt';
  const uri = vscode.Uri.joinPath(root.uri, path);
  const original = 'alpha\nseparator\nomega\n';
  const panel = frame.getByRole('region', { name: 'Proposed changes', exact: true });
  const status = panel.getByRole('status');
  const feedback = () => turns.at(-1)?.text.find(text => text.startsWith('Editor review updates'));
  async function send(text: string, failed = false): Promise<void> {
    const expected = turns.length + 1;
    await frame.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    await frame.getByRole('log').getByText(failed ? /Feedback fixture temporary failure/ : `Review feedback response ${expected}`, { exact: !failed }).waitFor();
    await frame.locator('#message-input:not([disabled])').waitFor();
  }
  async function stage(text: string): Promise<string> {
    const read = await client.callTool({ name: 'read_file', arguments: { path } });
    const data: unknown = read.structuredContent;
    assert.ok(typeof data === 'object' && data !== null && 'base_revision' in data && typeof data.base_revision === 'string');
    const result = await client.callTool({ name: 'propose_edit', arguments: { path, base_revision: data.base_revision, new_text: text, explanation: 'Review feedback regression' } });
    const proposal: unknown = result.structuredContent;
    assert.ok(!result.isError && typeof proposal === 'object' && proposal !== null && 'proposal_id' in proposal && typeof proposal.proposal_id === 'string');
    await panel.locator(`[data-proposal-id="${proposal.proposal_id}"]`).waitFor();
    return proposal.proposal_id;
  }
  const row = (id: string) => panel.locator(`[data-proposal-id="${id}"]`);
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(original));
    const config = vscode.workspace.getConfiguration('forgeAgent');
    await config.update('baseUrl', `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Workspace);
    await config.update('model', 'test/review-feedback', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('forgeAgent.newTask');
    const instruction = 'Change alpha to ALPHA.';
    await send(instruction);
    assert.equal(feedback(), undefined);
    const first = await stage('ALPHA\nseparator\nomega\n');
    await row(first).getByRole('button', { name: 'Apply file', exact: true }).click();
    await status.filter({ hasText: 'Applied and saved 1 file(s)' }).waitFor();
    await panel.getByRole('button', { name: 'Undo last apply', exact: true }).click();
    await status.filter({ hasText: 'Undid the last applied batch' }).waitFor();
    assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), original);
    assert.equal(turns.length, 1, 'Review clicks must not trigger model calls');
    await send(instruction);
    assert.equal(sessions, 1, 'Undo must preserve the existing conversation');
    assert.equal(turns[0]?.path, turns[1]?.path);
    assert.ok(feedback()?.includes('"action":"apply"'));
    assert.ok(feedback()?.includes('"action":"undo"'));
    assert.ok(feedback()?.includes('"status":"undone"'));
    assert.ok(feedback()?.includes('read_file'));
    const second = await stage('ALPHA\nseparator\nomega\n');
    assert.notEqual(second, first);
    await row(second).getByRole('button', { name: 'Reject', exact: true }).click();
    await status.filter({ hasText: 'Rejected 1 proposal' }).waitFor();
    await send('Continue after rejecting.');
    assert.ok(feedback()?.includes('"action":"reject"'));
    assert.ok(!feedback()?.includes('"action":"undo"'), 'Delivered feedback must not repeat');
    const third = await stage('ALPHA\nseparator\nOMEGA\n');
    await row(third).getByRole('button', { name: 'Preview', exact: true }).click();
    await status.filter({ hasText: 'Preview opened' }).waitFor();
    await send('Continue after previewing.');
    assert.equal(feedback(), undefined, 'Opening a preview is not a file change');
    await row(third).getByRole('button', { name: 'Accept hunk', exact: true }).first().click();
    await status.filter({ hasText: 'Accepted and saved this hunk' }).waitFor();
    await row(third).getByRole('button', { name: 'Reject hunk', exact: true }).click();
    await status.filter({ hasText: 'Rejected this hunk' }).waitFor();
    failNext = true;
    await send('Continue after partial review.', true);
    const failedFeedback = feedback();
    await send('Retry after the temporary failure.');
    assert.equal(feedback(), failedFeedback, 'Failed sends must retain review outcomes');
    assert.ok(feedback()?.includes('"applied":1,"rejected":1'));
    await panel.getByRole('button', { name: 'Undo last apply', exact: true }).click();
    await status.filter({ hasText: 'Undid the last applied batch' }).waitFor();
    await vscode.commands.executeCommand('forgeAgent.newTask');
    await send('Start a new task.');
    assert.equal(feedback(), undefined, 'New Task must not inherit previous feedback');
    assert.equal(sessions, 2);
    approvalMode = true;
    for (const [index, allow] of [true, false].entries()) {
      await vscode.commands.executeCommand('forgeAgent.newTask');
      await frame.getByRole('textbox', { name: 'Message', exact: true }).fill('Approval API regression');
      await frame.getByRole('button', { name: 'Send', exact: true }).click();
      await frame.locator('#approve-button:not([disabled])').waitFor();
      const count: number = turns.length;
      if (allow) {
        failNext = true;
        await frame.locator('#approve-button').click();
        await frame.locator('#status').filter({ hasText: 'Feedback fixture temporary failure' }).waitFor();
        await frame.locator('#approve-button:not([disabled])').waitFor();
      }
      await frame.locator(allow ? '#approve-button' : '#deny-button').click();
      await frame.getByRole('log').getByText(`Approval resumed ${index + 1}`, { exact: true }).waitFor();
      await frame.locator('#message-input:not([disabled])').waitFor();
      await frame.locator('#approve-button').waitFor({ state: 'hidden' });
      assert.equal(turns.length, count, 'Approve/Deny must resume the existing turn');
      assert.equal(approvalRequests.at(-1)?.path, `/api/v1/sessions/feedback-session-${sessions}/turns/feedback-turn-${count}/events`);
      assert.deepEqual(approvalRequests.at(-1)?.events, ['one', 'two'].map(tool_call_id => ({ type: 'user.tool_approval', thread_id: 'main', tool_call_id, approval: allow ? { status: 'allow' } : { status: 'deny', reason: 'Declined in VS Code' } })));
    }
    assert.equal(approvalRequests.length, 3, 'One failed submission, one retry and one denial');
    assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), original);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(options.extensionUri, 'out-test', 'review-feedback-result.json'), new TextEncoder().encode(JSON.stringify({ same_session_apply_undo_repeat: true, fresh_proposal: true, partial_review: true, no_preview_feedback: true, no_extra_model_calls: true, retry_retains_feedback: true, new_task_clears_feedback: true })));
    await vscode.commands.executeCommand('forgeAgent.newTask');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
