import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { chromium } from 'playwright-core';
import type { Frame } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function configuration(): { instruction: string; workspace: string; python: string; commit: string; model?: string; reasoningEffort?: string; baseUrl: string; resultFile: string; verifier: string } {
  const path = process.env.FORGE_TASK_A_CONFIG;
  if (!path) throw new Error('Use pnpm run test:task-a.');
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof data !== 'object' || data === null || !('instruction' in data) || typeof data.instruction !== 'string'
    || !('workspace' in data) || typeof data.workspace !== 'string' || !('python' in data) || typeof data.python !== 'string'
    || !('commit' in data) || typeof data.commit !== 'string' || !('baseUrl' in data) || typeof data.baseUrl !== 'string'
    || !('resultFile' in data) || typeof data.resultFile !== 'string' || !('verifier' in data) || typeof data.verifier !== 'string') throw new Error('Invalid Task A test configuration.');
  const model = 'model' in data && typeof data.model === 'string' ? data.model : undefined;
  const reasoningEffort = 'reasoningEffort' in data && typeof data.reasoningEffort === 'string' ? data.reasoningEffort : undefined;
  return { instruction: data.instruction, workspace: data.workspace, python: data.python, commit: data.commit, baseUrl: data.baseUrl, resultFile: data.resultFile, verifier: data.verifier, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}
function runPython(options: { python: string; workspace: string; source: string; debug?: string }): string {
  const result = spawnSync(options.python, ['-c', options.source], { cwd: options.workspace, env: { ...process.env, FLASK_DEBUG: options.debug ?? '' }, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw new Error('Python verification could not run.', { cause: result.error });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
export async function run(): Promise<void> {
  const config = configuration();
  const report: Record<string, unknown> = { passed: false, mode: config.model ? 'live_trueforge' : 'editor_fixture', model: config.model ?? null, reasoning_effort: config.reasoningEffort ?? 'provider_default', pinned_commit: config.commit };
  let frame: Frame | undefined;
  let originalBytes: Uint8Array | undefined;
  let target: vscode.Uri | undefined;
  try {
    const extension = vscode.extensions.getExtension('mukulkumar.forge-agent');
    assert.ok(extension); await extension.activate();
    const settings = vscode.workspace.getConfiguration('forgeAgent');
    await settings.update('baseUrl', config.baseUrl, vscode.ConfigurationTarget.Global);
    if (config.model) await settings.update('model', config.model, vscode.ConfigurationTarget.Global);
    if (config.reasoningEffort) await settings.update('reasoningEffort', config.reasoningEffort, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('forgeAgent.open');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.FORGE_SMOKE_CDP_PORT}`);
    const deadline = Date.now() + 20_000;
    while (!frame && Date.now() < deadline) {
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        for (const candidate of page.frames()) {
          if (!candidate.isDetached() && await candidate.locator('#message-input').count()) { frame = candidate; break; }
        }
      }
      if (!frame) await setTimeout(100);
    }
    assert.ok(frame, 'Sidebar did not open.');
    await frame.locator('#status').filter({ hasText: 'Set forgeAgent.model' }).waitFor();
    await frame.page().bringToFront();
    const file = vscode.Uri.file(join(config.workspace, 'src/flask/helpers.py'));
    const original = await vscode.workspace.fs.readFile(file);
    originalBytes = original; target = file;
    const document = await vscode.workspace.openTextDocument(file);
    const originalText = document.getText();
    const lines = originalText.split('\n');
    const start = lines.findIndex(line => line.startsWith('def get_debug_flag('));
    assert.ok(start >= 0);
    let end = start + 1;
    while (end < lines.length && (lines[end]?.startsWith(' ') || lines[end] === '')) end++;
    while (end > start && !lines[end - 1]?.trim()) end--;
    const selection = new vscode.Selection(start, 0, end, 0);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = selection;
    const inline = vscode.commands.executeCommand('forgeAgent.editSelection');
    const box = frame.page().locator('.quick-input-widget input');
    await box.waitFor({ state: 'visible' }); await box.fill(config.instruction); await box.press('Enter');
    await frame.getByRole('log').getByText(config.instruction, { exact: false }).first().waitFor();
    report.inline_selection_submitted = true;
    const review = frame.getByRole('region', { name: 'Proposed changes', exact: true });
    if (!config.model) {
      await inline;
      await frame.getByRole('log').getByText('Model not configured. Set forgeAgent.model after adding a model in local TrueForge.', { exact: true }).waitFor();
      const previousClipboard = await vscode.env.clipboard.readText();
      await vscode.commands.executeCommand('forgeAgent.copyMcp');
      const value: unknown = JSON.parse(await vscode.env.clipboard.readText());
      await vscode.env.clipboard.writeText(previousClipboard);
      if (typeof value !== 'object' || value === null || !('url' in value) || typeof value.url !== 'string' || !('headers' in value)
        || typeof value.headers !== 'object' || value.headers === null || !('Authorization' in value.headers) || typeof value.headers.Authorization !== 'string') throw new Error('Invalid editor connection.');
      const client = new Client({ name: 'forge-task-a-editor-fixture', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(value.url), { requestInit: { headers: { Authorization: value.headers.Authorization } } }));
      const read = await client.callTool({ name: 'read_file', arguments: { path: 'src/flask/helpers.py', start_line: start + 1, end_line: end } });
      const data: unknown = read.structuredContent;
      if (typeof data !== 'object' || data === null || !('base_revision' in data) || typeof data.base_revision !== 'string') throw new Error('No base revision.');
      assert.ok('text' in data && typeof data.text === 'string' && data.text.includes('def get_debug_flag'), 'Structured MCP reads must include the selected source.');
      const replacement = `def get_debug_flag() -> bool:\n    """Get whether debug mode is enabled by :envvar:\`FLASK_DEBUG\`.\n\n    Unset or empty values and \`\`0\`\`, \`\`false\`\`, \`\`no\`\`, \`\`off\`\`,\n    and \`\`n\`\` are false, case-insensitively. All other values are true.\n    """\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})\n`;
      const staged = await client.callTool({ name: 'propose_edit', arguments: { path: 'src/flask/helpers.py', base_revision: data.base_revision, start_line: start + 1, end_line: end, new_text: replacement, explanation: 'Deterministic editor fixture; this proposal was not generated by a model.' } });
      assert.equal(staged.isError, undefined, JSON.stringify(staged)); await client.close();
    } else {
      const until = Date.now() + 180_000;
      while (Date.now() < until && await review.locator('[data-hunk-id]').count() === 0) {
        const approve = frame.getByRole('button', { name: 'Approve preview', exact: true });
        if (await approve.isVisible() && await approve.isEnabled()) await approve.click();
        const status = await frame.locator('#status').innerText();
        const sessionId = /Session ([^\s]+)/.exec(status)?.[1];
        if (sessionId) report.session_id = sessionId;
        if (/quota|429|RESOURCE_EXHAUSTED|invalid|Unauthorized|not found|Unprocessable|error|failed|timed out/i.test(status)) throw new Error(status);
        await setTimeout(200);
      }
      await inline;
      assert.ok(await review.locator('[data-hunk-id]').count() > 0, 'The real model did not produce a proposal.');
      const ready = Date.now() + 30_000;
      while (await frame.locator('#cancel-button').isEnabled() && Date.now() < ready) await setTimeout(100);
      report.trueforge_status = await frame.locator('#status').innerText();
      const sessionId = /Session ([^\s]+)/.exec(String(report.trueforge_status))?.[1];
      if (sessionId) report.session_id = sessionId;
    }
    assert.deepEqual(await vscode.workspace.fs.readFile(file), original, 'Staging wrote to disk.');
    report.preview_does_not_write = true;
    await frame.locator('#review-panel').screenshot({ path: join(config.workspace, '..', 'task-a-proposal.png') });
    let accepted = 0;
    while (await review.getByRole('button', { name: 'Accept hunk', exact: true }).count()) {
      await review.getByRole('button', { name: 'Accept hunk', exact: true }).first().click();
      await review.getByRole('status').filter({ hasText: 'Accepted and saved this hunk' }).waitFor();
      accepted++;
      const pending = Date.now() + 5000;
      while (await review.locator('.hunk-row h4').filter({ hasText: 'applied' }).count() < accepted && Date.now() < pending) await setTimeout(50);
      if (accepted > 20) throw new Error('Unexpectedly many hunks for Task A.');
    }
    assert.ok(accepted > 0);
    report.accepted_hunks = accepted;
    report.verification = runPython({ ...config, source: 'from flask.helpers import get_debug_flag; print(get_debug_flag())', debug: 'off' });
    assert.equal(report.verification, 'False');
    const checks = spawnSync(config.python, [config.verifier], { cwd: config.workspace, encoding: 'utf8', timeout: 30_000 });
    assert.equal(checks.status, 0, checks.stderr);
    report.behavior_and_docstring = checks.stdout.trim();
    const currentText = (await vscode.workspace.openTextDocument(file)).getText();
    const beforeOffset = document.offsetAt(new vscode.Position(start, 0));
    const suffix = lines.slice(end).join('\n');
    assert.ok(currentText.startsWith(originalText.slice(0, beforeOffset)) && currentText.endsWith(suffix), 'The proposal changed code outside the selected function.');
    const pytest = spawnSync(config.python, ['-m', 'pytest', 'tests/test_helpers.py', '-q'], { cwd: config.workspace, encoding: 'utf8', timeout: 60_000 });
    assert.equal(pytest.status, 0, `${pytest.stderr}\n${pytest.stdout}`);
    report.pytest = pytest.stdout.trim();
    await frame.locator('#review-panel').screenshot({ path: join(config.workspace, '..', 'task-a-applied.png') });
    for (let index = 0; index < accepted; index++) {
      await review.getByRole('button', { name: 'Undo last apply', exact: true }).click();
      await review.getByRole('status').filter({ hasText: 'Undid the last applied batch' }).waitFor();
      const pending = Date.now() + 5000;
      while (await review.locator('.hunk-row h4').filter({ hasText: 'undone' }).count() < index + 1 && Date.now() < pending) await setTimeout(50);
    }
    assert.deepEqual(await vscode.workspace.fs.readFile(file), original);
    report.undo_restores_original_bytes = true;
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: config.workspace, encoding: 'utf8' });
    assert.equal(status.stdout.trim(), ''); report.git_status_clean = true;
    report.task_a_verified = true;
    report.passed = true;
    await browser.close();
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    if (frame) await frame.locator('body').screenshot({ path: join(config.workspace, '..', 'task-a-error.png') }).catch(() => undefined);
    if (originalBytes && target) {
      for (let index = 0; index < 20; index++) {
        if (Buffer.from(await vscode.workspace.fs.readFile(target)).equals(Buffer.from(originalBytes))) break;
        await vscode.commands.executeCommand('forgeAgent.undo');
      }
      report.failure_cleanup_restored_original = Buffer.from(await vscode.workspace.fs.readFile(target)).equals(Buffer.from(originalBytes));
    }
    throw error;
  } finally { writeFileSync(config.resultFile, JSON.stringify(report, null, 2)); }
}
