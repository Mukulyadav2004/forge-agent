import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as vscode from 'vscode';
import { z } from 'zod';

const RowSchema = z.object({
  ts: z.string(), taskId: z.null(), event: z.literal('tool.call'), name: z.string(), outcome: z.string(),
  resultChars: z.number().int().nonnegative(), durationMs: z.number().nonnegative(), path: z.string().optional(),
  pathRefused: z.boolean().optional(), queryChars: z.number().optional(), truncated: z.boolean().optional(), errorType: z.string().optional(),
});

export async function checkToolLog(options: { client: Client; extensionUri: vscode.Uri; authorization: string }): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root);
  const probe = 'logging-probe.txt', secret = '.env.logging-private', alias = 'logging-secret-alias.txt';
  const sensitive = 'dummy-observability-credential-never-persist-this';
  const files = [probe, secret, alias].map(name => join(root.uri.fsPath, name));
  try {
    await writeFile(join(root.uri.fsPath, probe), `${sensitive}\n`.repeat(4));
    await writeFile(join(root.uri.fsPath, secret), sensitive);
    await symlink(join(root.uri.fsPath, secret), join(root.uri.fsPath, alias));
    const before = (await readdir(root.uri.fsPath, { recursive: true })).sort();
    const contentsBefore = await readFile(join(root.uri.fsPath, probe));
    assert.equal((await options.client.callTool({ name: 'list_files', arguments: { glob: probe } })).isError, undefined);
    const read = await options.client.callTool({ name: 'read_file', arguments: { path: probe } });
    assert.equal(read.isError, undefined);
    const search = await options.client.callTool({ name: 'search_code', arguments: { query: sensitive, glob: probe, max_results: 1 } });
    assert.equal(search.isError, undefined);
    for (const path of [secret, alias]) {
      assert.equal((await options.client.callTool({ name: 'read_file', arguments: { path } })).isError, true);
    }
    assert.equal((await options.client.callTool({ name: 'propose_edit', arguments: { path: probe, base_revision: sensitive, new_text: sensitive, explanation: sensitive } })).isError, true);

    // The smoke runner owns this fresh profile; never search another VS Code profile.
    const directory = join(dirname(root.uri.fsPath), 'User', 'globalStorage', 'mukulkumar.forge-agent', 'observability');
    assert.ok(relative(root.uri.fsPath, directory).startsWith('..'));
    const windows = await readdir(directory);
    assert.equal(windows.length, 1);
    const window = windows[0];
    assert.ok(window);
    const logPath = join(directory, window, 'events.jsonl');
    let text = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      text = await readFile(logPath, 'utf8');
      if (text.endsWith('\n') && text.includes('"name":"propose_edit","outcome":"error"') && text.includes(`"path":"${probe}"`)) {
        const last = RowSchema.safeParse(JSON.parse(text.trim().split('\n').at(-1) ?? '{}'));
        if (last.success && last.data.name === 'propose_edit' && last.data.path === probe) break;
      }
      await setTimeout(20);
    }
    const all = text.trim().split('\n').map(line => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    const rows = all.filter(row => row.event === 'tool.call').map(row => RowSchema.parse(row));
    const starts = all.filter(row => row.event === 'session.start');
    assert.deepEqual(starts.map(row => row.sessionId), ['feedback-session-1', 'feedback-session-2']);
    assert.ok(starts.every(row => row.taskId === row.sessionId));
    const completed = all.filter(row => row.event === 'turn.end' && row.outcome === 'done');
    assert.ok(completed.length > 1);
    assert.ok(completed.every(row => typeof row.turnId === 'string' && row.turnId.startsWith('feedback-turn-') && typeof row.firstTextMs === 'number' && typeof row.durationMs === 'number' && row.firstTextMs <= row.durationMs));
    assert.ok(all.some(row => row.event === 'error' && row.errorType === 'RequestError' && row.taskId === 'feedback-session-1'));
    assert.ok(all.some(row => row.event === 'model.config' && row.model === 'test/review-feedback'));
    assert.ok(!text.includes('Review feedback response') && !text.includes('Feedback fixture temporary failure') && !text.includes('Change alpha to ALPHA.'));
    assert.deepEqual([...new Set(rows.map(row => row.name))].sort(), ['list_files', 'propose_edit', 'read_file', 'search_code']);
    const last = rows.slice(-5);
    assert.deepEqual(last.map(row => row.outcome), ['ok', 'ok', 'refused', 'refused', 'error']);
    assert.equal(last[0]?.path, probe);
    assert.equal(last[0]?.resultChars, JSON.stringify(read.structuredContent).length);
    assert.equal(last[1]?.queryChars, sensitive.length);
    assert.equal(last[1]?.truncated, true);
    assert.equal(last[1]?.resultChars, JSON.stringify(search.structuredContent).length);
    assert.ok(last.slice(2, 4).every(row => row.pathRefused && !row.path && row.errorType === 'PathRefused'));
    assert.ok(rows.some(row => row.name === 'propose_edit' && row.outcome === 'ok' && row.path === 'example.txt'));
    for (const forbidden of [sensitive, options.authorization, options.authorization.replace(/^Bearer /u, ''), secret, alias, 'original text', 'proposed text']) assert.ok(!text.includes(forbidden), 'Sensitive value reached JSONL');
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(logPath))).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(root.uri.fsPath, { recursive: true })).sort(), before);
    assert.deepEqual(await readFile(join(root.uri.fsPath, probe)), contentsBefore);
    await writeFile(vscode.Uri.joinPath(options.extensionUri, 'out-test', 'observability-result.json').fsPath, JSON.stringify({ passed: true, tool_events: rows.length, all_four_tools: true, redaction: true, secret_and_alias_refused: true, storage_outside_workspace: true, workspace_unchanged: true, sdk_fixture_sessions: starts.length, sdk_fixture_completed_turns: completed.length, turn_timing: true, safe_sdk_errors: true, task_join: 'Real SDK IDs recorded; MCP rows remain unjoined.' }, null, 2));
  } finally {
    for (const path of files) await rm(path, { force: true });
  }
}
