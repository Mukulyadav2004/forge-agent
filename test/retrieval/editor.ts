import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import * as vscode from 'vscode';
import { chromium } from 'playwright-core';
import type { Browser, Frame } from 'playwright-core';
import { z } from 'zod';
import { measureTrace } from './metrics';

const ConfigurationSchema = z.object({ workspace: z.string(), directory: z.string(), resultFile: z.string(), baseUrl: z.string(), model: z.string(), instruction: z.string(), attempt: z.number().int().positive() });
const EventsPageSchema = z.object({ data: z.array(z.object({ event: z.unknown() })), pagination: z.object({ next_page_token: z.string().nullish() }).optional() });
const SessionSchema = z.object({ data: z.object({ agent: z.object({ spec: z.object({ model: z.object({ name: z.string() }) }) }), last_turn_details: z.object({ state: z.object({ status: z.string() }) }) }) });

async function sidebar(browser: Browser): Promise<Frame> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      for (const frame of page.frames()) if (!frame.isDetached() && await frame.locator('#message-input').count()) return frame;
    }
    await setTimeout(100);
  }
  throw new Error('The real Forge sidebar did not open.');
}

export async function run(): Promise<void> {
  const configFile = process.env.FORGE_RETRIEVAL_CONFIG;
  assert.ok(configFile, 'Use pnpm run test:retrieval.');
  const config = ConfigurationSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
  const report: Record<string, unknown> = { attempt: config.attempt, measurement_complete: false, model: config.model, prompt: config.instruction, checked_at: new Date().toISOString(), evaluation_targets_not_sent_to_model: ['tests/test_cli.py', 'docs/cli.rst'] };
  let browser: Browser | undefined;
  let frame: Frame | undefined;
  let sessionId: string | undefined;
  function git(args: string[]): string {
    const result = spawnSync('git', args, { cwd: config.workspace, encoding: 'utf8', timeout: 10000 });
    if (result.error) throw new Error('Fixture Git inspection failed.', { cause: result.error });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  }
  function digest(): string {
    const hash = createHash('sha256');
    for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean).sort()) hash.update(path).update('\0').update(readFileSync(join(config.workspace, path)));
    return hash.digest('hex');
  }
  async function json(path: string): Promise<unknown> {
    const response = await fetch(`${config.baseUrl}${path}`, { signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, `TrueForge inspection failed: ${response.status}`);
    return response.json();
  }
  async function collect(): Promise<void> {
    if (!sessionId) return;
    const events: unknown[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < 10; page++) {
      const data = EventsPageSchema.parse(await json(`/api/v1/sessions/${sessionId}/events?limit=100${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ''}`));
      events.push(...data.data.map(row => row.event));
      cursor = data.pagination?.next_page_token ?? undefined;
      if (!cursor) { complete = true; break; }
    }
    writeFileSync(join(config.directory, 'events.json'), JSON.stringify(events, null, 2));
    Object.assign(report, measureTrace({ events, targets: ['tests/test_cli.py', 'docs/cli.rst'] }));
    report.trace_complete = complete;
    report.event_count = events.length;
    assert.ok(complete, 'The trace exceeded the event pagination budget.');
    const session = SessionSchema.parse(await json(`/api/v1/sessions/${sessionId}`));
    report.actual_model = session.data.agent.spec.model.name;
    assert.equal(report.actual_model, config.model);
    report.final_turn_status = session.data.last_turn_details.state.status;
    report.measurement_complete = true;
  }
  const before = digest();
  try {
    report.pinned_commit = git(['rev-parse', 'HEAD']);
    assert.equal(report.pinned_commit, '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
    report.git_status_before = git(['status', '--porcelain']);
    assert.equal(report.git_status_before, '');
    report.workspace_hash_before = before;
    const health = await json('/healthz');
    if (typeof health === 'object' && health !== null && 'version' in health) report.trueforge_version = health.version;
    const extension = vscode.extensions.getExtension('mukulkumar.forge-agent');
    assert.ok(extension);
    await extension.activate();
    const settings = vscode.workspace.getConfiguration('forgeAgent');
    await settings.update('baseUrl', config.baseUrl, vscode.ConfigurationTarget.Global);
    await settings.update('model', config.model, vscode.ConfigurationTarget.Global);
    await settings.update('reasoningEffort', '', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('forgeAgent.open');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.FORGE_SMOKE_CDP_PORT}`);
    frame = await sidebar(browser);
    await frame.locator('#message-input:not([disabled])').waitFor();
    const previousClipboard = await vscode.env.clipboard.readText();
    try {
      await vscode.commands.executeCommand('forgeAgent.copyMcp');
      const connection = z.object({ name: z.string() }).parse(JSON.parse(await vscode.env.clipboard.readText()));
      report.connector_name = connection.name;
    } finally { await vscode.env.clipboard.writeText(previousClipboard); }
    const started = Date.now();
    await frame.getByRole('textbox', { name: 'Message', exact: true }).fill(config.instruction);
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    await frame.getByRole('log').getByText(config.instruction, { exact: true }).waitFor();
    const deadline = Date.now() + 180000;
    let ended = false;
    while (Date.now() < deadline) {
      const status = await frame.locator('#status').innerText();
      report.editor_status = status;
      const id = /Session ([^\s]+)/.exec(status)?.[1];
      if (id && id !== 'starting') { sessionId = id; report.session_id = id; }
      if (await frame.locator('#approve-button').isVisible()) throw new Error('The read-only baseline unexpectedly requested edit approval.');
      if (await frame.locator('#message-input').isEnabled()) { ended = true; break; }
      await setTimeout(100);
    }
    report.elapsed_ms = Date.now() - started;
    if (!ended) throw new Error('The baseline exceeded its three-minute request budget.');
    assert.ok(sessionId, `No TrueForge session was observed: ${report.editor_status}`);
    await collect();
    report.answer = await frame.locator('#messages').innerText();
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    if (frame) {
      const cancel = frame.getByRole('button', { name: 'Cancel', exact: true });
      if (await cancel.isVisible() && await cancel.isEnabled()) await cancel.click().catch(() => undefined);
    }
    if (sessionId) {
      try { await collect(); }
      catch (failure) { report.trace_error = failure instanceof Error ? failure.message : String(failure); }
    }
  } finally {
    report.git_status_after = git(['status', '--porcelain']);
    report.workspace_hash_after = digest();
    report.workspace_unchanged = report.git_status_after === '' && report.workspace_hash_after === before;
    writeFileSync(config.resultFile, JSON.stringify(report, null, 2));
    await browser?.close();
  }
}
