import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import * as vscode from 'vscode';
import { chromium } from 'playwright-core';
import type { Browser, Frame } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function configuration() {
  const path = process.env.FORGE_CANCEL_CONFIG;
  if (!path) throw new Error('Use pnpm run test:cancel.');
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(typeof data === 'object' && data !== null && 'workspace' in data && typeof data.workspace === 'string'
    && 'directory' in data && typeof data.directory === 'string' && 'resultFile' in data && typeof data.resultFile === 'string'
    && 'baseUrl' in data && typeof data.baseUrl === 'string' && 'model' in data && typeof data.model === 'string');
  return { workspace: data.workspace, directory: data.directory, resultFile: data.resultFile, baseUrl: data.baseUrl, model: data.model };
}
async function sidebar(browser: Browser): Promise<Frame> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      for (const frame of page.frames()) if (!frame.isDetached() && await frame.locator('#message-input').count()) return frame;
    }
    await setTimeout(100);
  }
  throw new Error('The real Forge sidebar did not open.');
}

export async function run(): Promise<void> {
  const config = configuration();
  const report: Record<string, unknown> = { passed: false, mode: 'live_trueforge_native_cancel', checked_at: new Date().toISOString(), model: config.model,
    pending_proposal_origin: 'Deterministic MCP fixture; model streaming and cancellation are live.', prompt: 'Read src/flask/helpers.py lines 1-120, then write a detailed 100-item numbered review checklist explaining how to refactor these helpers safely, with examples. Start the checklist immediately after reading. Do not propose edits or run commands.' };
  let frame: Frame | undefined;
  let browser: Browser | undefined;
  let client: Client | undefined;
  function git(args: string[]): string {
    const result = spawnSync('git', args, { cwd: config.workspace, encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw new Error('Fixture Git inspection failed.', { cause: result.error });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  }
  function digest(): string {
    const hash = createHash('sha256');
    for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean).sort()) hash.update(path).update('\0').update(readFileSync(join(config.workspace, path)));
    return hash.digest('hex');
  }
  async function session(): Promise<{ status: string }> {
    assert.equal(typeof report.session_id, 'string');
    const response = await fetch(`${config.baseUrl}/api/v1/sessions/${report.session_id}`, { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, `Session lookup failed: ${response.status}`);
    const value: unknown = await response.json();
    assert.ok(typeof value === 'object' && value !== null && 'data' in value);
    const data = value.data;
    assert.ok(typeof data === 'object' && data !== null && 'last_turn_details' in data);
    const turn = data.last_turn_details;
    assert.ok(typeof turn === 'object' && turn !== null && 'state' in turn);
    const state = turn.state;
    assert.ok(typeof state === 'object' && state !== null && 'status' in state && typeof state.status === 'string');
    return { status: state.status };
  }
  const before = digest();
  try {
    report.pinned_commit = git(['rev-parse', 'HEAD']);
    assert.equal(report.pinned_commit, '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
    report.git_status_before = git(['status', '--porcelain']); assert.equal(report.git_status_before, '');
    report.workspace_hash_before = before;
    const health = await fetch(`${config.baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (health.ok) { const value: unknown = await health.json(); if (typeof value === 'object' && value !== null && 'version' in value) report.trueforge_version = value.version; }
    const extension = vscode.extensions.getExtension('mukulkumar.forge-agent'); assert.ok(extension); await extension.activate();
    const settings = vscode.workspace.getConfiguration('forgeAgent');
    await settings.update('baseUrl', config.baseUrl, vscode.ConfigurationTarget.Global);
    await settings.update('model', config.model, vscode.ConfigurationTarget.Global);
    await settings.update('reasoningEffort', '', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('forgeAgent.open');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.FORGE_SMOKE_CDP_PORT}`);
    frame = await sidebar(browser); await frame.page().bringToFront();
    await frame.locator('#message-input:not([disabled])').waitFor();
    const clipboard = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand('forgeAgent.copyMcp');
    const connection: unknown = JSON.parse(await vscode.env.clipboard.readText());
    await vscode.env.clipboard.writeText(clipboard);
    assert.ok(typeof connection === 'object' && connection !== null && 'url' in connection && typeof connection.url === 'string'
      && 'name' in connection && typeof connection.name === 'string' && 'headers' in connection && typeof connection.headers === 'object' && connection.headers !== null
      && 'Authorization' in connection.headers && typeof connection.headers.Authorization === 'string');
    report.connector_name = connection.name;
    client = new Client({ name: 'forge-cancel-check', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: connection.headers.Authorization } } }));
    const path = 'src/flask/helpers.py';
    const read = await client.callTool({ name: 'read_file', arguments: { path, start_line: 28, end_line: 33 } });
    const source: unknown = read.structuredContent;
    assert.ok(typeof source === 'object' && source !== null && 'text' in source && typeof source.text === 'string' && 'base_revision' in source && typeof source.base_revision === 'string');
    const args = { path, base_revision: source.base_revision, start_line: 28, end_line: 33, new_text: source.text.replace('"no"}', '"no", "off", "n"}'), explanation: 'Unaccepted deterministic proposal for cancellation safety verification.' };
    const staged = await client.callTool({ name: 'propose_edit', arguments: args }); assert.equal(staged.isError, undefined);
    const review = frame.locator('#review-panel');
    await review.getByRole('button', { name: 'Apply file', exact: true }).waitFor();
    assert.equal(digest(), before); report.pending_proposal_does_not_write = true;
    assert.equal(typeof report.prompt, 'string');
    await frame.getByRole('textbox', { name: 'Message', exact: true }).fill(String(report.prompt));
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    const until = Date.now() + 100_000;
    const samples: { elapsed_ms: number; characters: number }[] = [];
    const started = Date.now();
    while (Date.now() < until) {
      const status = await frame.locator('#status').innerText();
      const id = /Session ([^\s]+)/.exec(status)?.[1]; if (id) report.session_id = id;
      if (/429|quota|RESOURCE_EXHAUSTED|Unauthorized|Unprocessable|failed|timed out/i.test(status)) throw new Error(status);
      const text = await frame.locator('#messages .message').filter({ has: frame.locator('.message-author').filter({ hasText: 'Forge' }) }).allTextContents();
      const characters = text.join('').length;
      if (characters > 40 && (!samples.length || characters > (samples.at(-1)?.characters ?? 0))) samples.push({ elapsed_ms: Date.now() - started, characters });
      if (samples.length >= 2 && report.session_id && await frame.locator('#message-input').isDisabled()) break;
      if (await frame.locator('#message-input').isEnabled() && id) throw new Error('The live request ended before streaming could be cancelled.');
      await setTimeout(100);
    }
    report.stream_samples = samples; assert.ok(samples.length >= 2, 'No incremental live text was observed.');
    report.status_before_cancel = (await session()).status; assert.equal(report.status_before_cancel, 'running');
    const responsiveness = Date.now(); await vscode.commands.executeCommand('forgeAgent.open');
    report.editor_command_ms = Date.now() - responsiveness; assert.ok(Number(report.editor_command_ms) < 1500, 'Editor command was blocked during generation.');
    await frame.locator('body').screenshot({ path: join(config.directory, 'streaming.png') });
    const clicked = Date.now(); await frame.getByRole('button', { name: 'Cancel', exact: true }).click();
    await frame.locator('#message-input:not([disabled])').waitFor({ timeout: 10_000 });
    report.cancel_to_input_enabled_ms = Date.now() - clicked;
    const stopped = Date.now() + 10_000;
    while ((await session()).status !== 'cancelled' && Date.now() < stopped) await setTimeout(100);
    report.final_turn_status = (await session()).status; assert.equal(report.final_turn_status, 'cancelled');
    assert.ok(Number(report.cancel_to_input_enabled_ms) < 2500, 'Cancellation did not restore the composer within 2.5 seconds.');
    assert.equal(await review.getByRole('button', { name: 'Apply file', exact: true }).count(), 0);
    assert.equal(await review.getByRole('button', { name: 'Accept hunk', exact: true }).count(), 0);
    report.pending_proposals_discarded = true;
    const stale = await client.callTool({ name: 'propose_edit', arguments: args }); assert.equal(stale.isError, true); report.stale_proposal_refused = true;
    await setTimeout(300); const settled = await frame.locator('#messages').innerText();
    await setTimeout(1000); assert.equal(await frame.locator('#messages').innerText(), settled); report.text_stopped = true;
    report.git_status_after = git(['status', '--porcelain']); assert.equal(report.git_status_after, '');
    report.workspace_hash_after = digest(); assert.equal(report.workspace_hash_after, before);
    await frame.locator('body').screenshot({ path: join(config.directory, 'cancelled.png') });
    await vscode.commands.executeCommand('forgeAgent.newTask');
    await frame.locator('#status').filter({ hasText: 'New task ready' }).waitFor(); report.new_task_ready = true;
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    if (frame) {
      await frame.locator('body').screenshot({ path: join(config.directory, 'error.png') }).catch(() => undefined);
      const cancel = frame.getByRole('button', { name: 'Cancel', exact: true });
      if (await cancel.isVisible() && await cancel.isEnabled()) await cancel.click().catch(() => undefined);
    }
    report.git_status_after = git(['status', '--porcelain']); report.workspace_hash_after = digest();
    throw error;
  } finally {
    await client?.close();
    writeFileSync(config.resultFile, JSON.stringify(report, null, 2));
    await browser?.close();
  }
}
