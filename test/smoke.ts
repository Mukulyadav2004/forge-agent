import { checkEditorTransactions } from './edits/realEditor';
import { checkReviewFeedback } from './sidebar/reviewFeedback';
import { checkSearch } from './tools/search';
import { checkCommand } from './tools/command';
import { checkDiskTruth } from './tools/diskTruth';
import { checkToolLog } from './observability/editor';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";
import type { Browser, Frame } from "playwright-core";

async function findSidebarFrame(browser: Browser): Promise<Frame> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      for (const frame of page.frames()) {
        if (frame.isDetached()) {
          continue;
        }
        try {
          if ((await frame.locator("#message-input").count()) > 0) {
            return frame;
          }
        } catch (error) {
          if (!frame.isDetached()) {
            throw new Error("Could not inspect the sidebar frame.", { cause: error });
          }
        }
      }
    }
    await setTimeout(200);
  }
  throw new Error("The sidebar did not render its message input.");
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("mukulkumar.forge-agent");

  if (!extension) {
    throw new Error("VS Code did not discover the development extension.");
  }

  try {
    await runSidebarChecks(extension);
  } catch (error) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(extension.extensionUri, "out-test", "smoke-error.txt"),
      new TextEncoder().encode(error instanceof Error ? error.stack ?? error.message : String(error))
    );
    throw error;
  }
}

async function runSidebarChecks(extension: vscode.Extension<unknown>): Promise<void> {
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);

  if (!commands.includes("forgeAgent.open")) {
    throw new Error("VS Code did not register forgeAgent.open.");
  }
  assert.ok(commands.includes("forgeAgent.copyMcp"));
  assert.ok(commands.includes("forgeAgent.selectModel"));

  await vscode.commands.executeCommand("forgeAgent.open");

  const port = process.env.FORGE_SMOKE_CDP_PORT;
  if (port === undefined || !/^\d+$/.test(port)) {
    throw new Error("The sidebar smoke check needs a local debugging port.");
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const frame = await findSidebarFrame(browser);
  await frame.locator('#status').filter({ hasText: 'Set forgeAgent.model' }).waitFor();
  await frame.page().bringToFront();
  await vscode.commands.executeCommand("workbench.action.showCommands");
  const palette = frame.page().locator(".quick-input-widget");
  const paletteInput = palette.locator("input");
  await paletteInput.fill(">Forge: Copy Editor MCP Connection");
  await palette.getByText("Forge: Copy Editor MCP Connection", { exact: true }).waitFor();
  await paletteInput.press("Escape");
  const input = frame.getByRole("textbox", { name: "Message", exact: true });
  const send = frame.getByRole("button", { name: "Send", exact: true });
  await frame.locator("#message-input:not([disabled])").waitFor();
  assert.equal(await send.isDisabled(), true);

  await input.fill("Hello Forge!");
  await send.click();
  await frame.getByRole("log").getByText("Model not configured. Set forgeAgent.model after adding a model in local TrueForge.", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "");

  await input.fill("   ");
  assert.equal(await send.isDisabled(), true);

  const literalText = '<img src=x onerror="window.forgeInjected=true">';
  await input.fill(literalText);
  await input.press("Meta+Enter");
  await frame.getByRole("log").getByText(literalText, { exact: true }).waitFor();
  assert.equal(await frame.getByRole("log").locator("img").count(), 0);

  const draft = "Keep this draft when I switch views.";
  await input.fill(draft);
  await vscode.commands.executeCommand("workbench.view.explorer");
  await vscode.commands.executeCommand("forgeAgent.open");
  const restoredFrame = await findSidebarFrame(browser);
  await restoredFrame.locator("#message-input:not([disabled])").waitFor();
  assert.equal(await restoredFrame.getByRole("textbox", { name: "Message", exact: true }).inputValue(), draft);
  // The chat tab is named after the first message, so count only the conversation.
  assert.equal(await restoredFrame.locator("#messages").getByText("Hello Forge!", { exact: true }).count(), 1);
  await restoredFrame.locator("body").screenshot({
    path: vscode.Uri.joinPath(extension.extensionUri, "out-test", "sidebar.png").fsPath,
  });

  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(extension.extensionUri, "out-test", "smoke-result.json"),
    new TextEncoder().encode(
      JSON.stringify({
        extension_id: extension.id,
        command_registered: true,
        command_executed: true,
        message_roundtrip: true,
        draft_restored: true,
        literal_rendering: true,
        empty_message_blocked: true,
      })
    )
  );

  const previousClipboard = await vscode.env.clipboard.readText();
  await restoredFrame.getByRole("button", { name: "Copy MCP connection", exact: true }).click();
  const clipboardDeadline = Date.now() + 5_000;
  while (await vscode.env.clipboard.readText() === previousClipboard && Date.now() < clipboardDeadline) {
    await setTimeout(100);
  }
  const connection: unknown = JSON.parse(await vscode.env.clipboard.readText());
  if (typeof connection !== "object" || connection === null || !("url" in connection) || typeof connection.url !== "string" || !("headers" in connection) || typeof connection.headers !== "object" || connection.headers === null || !("Authorization" in connection.headers) || typeof connection.headers.Authorization !== "string") throw new Error("Invalid MCP connection details");
  const client = new Client({ name: "forge-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: connection.headers.Authorization } } }));
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['list_files', 'plan_task', 'propose_edit', 'read_file', 'run_command', 'search_code', 'write_file']);
  await checkSearch({ client, extensionUri: extension.extensionUri });
  await checkCommand({ client, frame: restoredFrame });
  // write_file through the real editor and MCP: staging writes nothing, Apply creates the file and its folder, Undo removes it.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceRoot);
  const createdUri = vscode.Uri.joinPath(workspaceRoot.uri, 'new-folder', 'created.txt');
  const created = await client.callTool({ name: 'write_file', arguments: { path: 'new-folder/created.txt', content: 'made by write_file\n', explanation: 'Smoke check of file creation' } });
  assert.equal(created.isError, undefined, JSON.stringify(created.content));
  await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(createdUri)), 'Staging a new file writes nothing.');
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: 'example.txt', content: 'x\n', explanation: 'Overwrite' } })).isError, true, 'write_file never overwrites an existing file.');
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: '.env', content: 'x\n', explanation: 'Secret' } })).isError, true, 'Secret paths stay unavailable.');
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: '../outside.txt', content: 'x\n', explanation: 'Escape' } })).isError, true, 'Paths outside the workspace are refused.');
  await vscode.commands.executeCommand('forgeAgent.applyAll');
  assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(createdUri)), 'made by write_file\n', 'Apply creates the file.');
  await vscode.commands.executeCommand('forgeAgent.undo');
  await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(createdUri)), 'Undo removes the created file.');
  await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceRoot.uri, 'new-folder'), { recursive: true });
  const read = await client.callTool({ name: "read_file", arguments: { path: "example.txt" } });
  assert.equal(read.isError, undefined);
  assert.ok(JSON.stringify(read).includes("original text"));
  const structuredRead: unknown = read.structuredContent;
  assert.ok(typeof structuredRead === 'object' && structuredRead !== null && 'text' in structuredRead && typeof structuredRead.text === 'string' && structuredRead.text.includes('original text'), 'TrueForge must receive the file text even when it selects only structuredContent.');
  assert.ok('total_lines' in structuredRead && structuredRead.total_lines === 1, 'A final newline ends the last line: read_file counts lines the way propose_edit does.');
  const noText = await client.callTool({ name: 'propose_edit', arguments: { path: 'example.txt', old_text: 'original text', explanation: 'Missing new_text' } });
  assert.equal(noText.isError, true);
  assert.match(JSON.stringify(noText.content), /new_text is required[^"]*To delete them, pass an empty string/u, 'A missing new_text says what to send.');
  await restoredFrame.locator('#messages .activity-group .activity-open').getByRole('button', { name: 'example.txt:1-1', exact: true }).last().waitFor();
  const escape = await client.callTool({ name: "read_file", arguments: { path: "../outside.txt" } });
  assert.equal(escape.isError, true);
  const readData: unknown = read.structuredContent;
  if (typeof readData !== 'object' || readData === null || !('base_revision' in readData) || typeof readData.base_revision !== 'string') throw new Error('read_file must return a base revision.');
  const baseRevision = readData.base_revision;
  // plan_task through real MCP: the plan is recorded with its sibling's footprint, and the next result carries the checklist.
  // A sidebar message starts a request with these words (no model is set yet, so it stops right after); plan_task must quote them.
  await restoredFrame.getByRole('textbox', { name: 'Message', exact: true }).fill('Please change the example, then document it.');
  await restoredFrame.getByRole('button', { name: 'Send', exact: true }).click();
  await restoredFrame.getByRole('log').getByText('Model not configured. Set forgeAgent.model after adding a model in local TrueForge.', { exact: true }).last().waitFor();
  const uncovered = await client.callTool({ name: 'plan_task', arguments: { requirements: [{ quote: 'change the example', change: 'Rewrite example.txt', file: 'example.txt' }] } });
  assert.match(JSON.stringify(uncovered.content), /not in your plan yet: \\"then document it\.\\"/u, 'A part of the request with no requirement is named back to the agent.');
  const planned = await client.callTool({ name: 'plan_task', arguments: { requirements: [{ quote: 'change the example', change: 'Rewrite example.txt', file: 'example.txt', sibling: 'original text' }, { quote: 'document it', change: 'Add notes', file: 'notes.md' }] } });
  assert.equal(planned.isError, undefined, JSON.stringify(planned.content));
  // The feed shows the plan in the agent's words, with the part of the request each step answers under it.
  const planRow = restoredFrame.locator('#messages .plan-item').filter({ hasText: 'Rewrite example.txt' }).last();
  await planRow.waitFor();
  assert.match(await planRow.innerText(), /^• Rewrite example\.txt → example\.txt \(like original text\)\s*for: "change the example"$/u);
  assert.match(await restoredFrame.locator('#messages').innerText(), /Agent's plan\s*2 steps, written by the model; Forge checks they cover every part of your request/u);
  // The same refused call again says so, so a model does not repeat it many times.
  const missingRead = { name: 'read_file', arguments: { path: 'no-such-file.txt' } };
  assert.match(JSON.stringify((await client.callTool(missingRead)).content), /no-such-file\.txt does not exist\. To create it, use write_file/u, 'A missing file gets a plain answer.');
  assert.match(JSON.stringify((await client.callTool(missingRead)).content), /This exact call was already refused 1 time\(s\)/u, 'A repeated refused call is named as a repeat.');
  assert.match(JSON.stringify(planned.content), /Plan recorded: 2 requirement\(s\)[\s\S]*original text appears in:[\s\S]*example\.txt:1/u, 'The sibling footprint lists where it appears.');
  const proposal = await client.callTool({ name: "propose_edit", arguments: { path: "example.txt", base_revision: baseRevision, new_text: "proposed text", explanation: "Smoke test" } });
  assert.equal(proposal.isError, undefined);
  assert.match(JSON.stringify(proposal.content), /Checklist: 1 of 2 requirement\(s\) have a change\. Still open: \\"document it\\" \(planned: notes\.md\)/u, 'A staged change updates the checklist in the tool result.');
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "example.txt"))), "original text\n");
  await checkEditorTransactions({ client, frame: restoredFrame, extensionUri: extension.extensionUri });
  await checkReviewFeedback({ client, frame: restoredFrame, extensionUri: extension.extensionUri });
  await checkToolLog({ client, extensionUri: extension.extensionUri, authorization: connection.headers.Authorization });
  await checkDiskTruth({ client, frame: restoredFrame });
  const pendingRead = await client.callTool({ name: 'read_file', arguments: { path: 'example.txt' } });
  const pendingRevision = (pendingRead.structuredContent as { base_revision: string }).base_revision;
  assert.equal((await client.callTool({ name: 'propose_edit', arguments: { path: 'example.txt', base_revision: pendingRevision, new_text: 'held turn check\n', explanation: 'Pending during a held turn' } })).isError, undefined);
  // Context budget: results report usage, and reads stop once one request has used 350,000 characters (a chat message later resets it).
  const budgetProbe = vscode.Uri.joinPath(folder.uri, 'budget-probe.txt');
  await vscode.workspace.fs.writeFile(budgetProbe, new TextEncoder().encode(Array.from({ length: 4000 }, (_, index) => `line ${index} ${'x'.repeat(90)}`).join('\n')));
  let budgetRefusal = '';
  let budgetUsed = 0;
  for (let start = 1; start < 4000 && !budgetRefusal; start += 300) {
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'budget-probe.txt', start_line: start, end_line: start + 299 } });
    if (result.isError) { budgetRefusal = JSON.stringify(result.content); continue; }
    const used = (result.structuredContent as { context_budget: { used: number; limit: number } }).context_budget.used;
    assert.ok(used > budgetUsed && used <= 350_000, `Budget use must grow and stay within the limit (${budgetUsed} -> ${used}).`);
    budgetUsed = used;
  }
  assert.match(budgetRefusal, /Context budget: [\d,]+ of 350,000 characters used for this request\. Too little remains/u);
  assert.ok(budgetUsed > 340_000, `The budget should be nearly spent before refusing (${budgetUsed}).`);
  await vscode.workspace.fs.delete(budgetProbe);
  await client.close();
  const denied = await fetch(connection.url, { method: "POST" });
  assert.equal(denied.status, 403);
  const streamProbe = await fetch(connection.url, { method: 'GET' });
  assert.deepEqual([streamProbe.status, streamProbe.headers.get('allow')], [405, 'POST'], 'Streamable HTTP servers without a GET stream must answer 405.');
  if (process.env.FORGE_SMOKE_LIVE_REGISTRY === "true") {
    await checkLiveRegistry({ url: connection.url, authorization: connection.headers.Authorization });
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extension.extensionUri, "out-test", "live-editor-result.json"), new TextEncoder().encode(JSON.stringify({ registration: true, trueforge_discovers_editor_tools: true })));
  }
  await vscode.env.clipboard.writeText(previousClipboard);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extension.extensionUri, "out-test", "mcp-result.json"), new TextEncoder().encode(JSON.stringify({ authenticated_tools: true, bounded_read: true, traversal_denied: true, proposal_no_write: true, unauthorized_denied: true })));
  await checkModelRecovery(browser);
  await vscode.commands.executeCommand('forgeAgent.rejectAll');
  console.log("MCP checks passed: authentication, tools, reads, traversal denial, proposal leaves disk unchanged.");
  console.log(`Smoke check passed: ${extension.id} exchanges sidebar messages and preserves drafts.`);
  await browser.close();
}

async function checkLiveRegistry(connection: { url: string; authorization: string }): Promise<void> {
  const baseUrl = "http://127.0.0.1:8790";
  const name = `forge-editor-smoke-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/v1/settings/mcp-servers`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest: { type: "remote", name, description: "Temporary editor connection check", url: connection.url, auth: { type: "header", headers: { Authorization: connection.authorization } } } }),
  });
  assert.equal(response.ok, true, `Live connector registration failed: ${response.status}`);
  try {
    const discovery = await fetch(`${baseUrl}/api/v1/mcp-servers/${name}/tools`);
    assert.equal(discovery.ok, true, `Live tool discovery failed: ${discovery.status}`);
    const body: unknown = await discovery.json();
    if (typeof body !== "object" || body === null || !("data" in body)) throw new Error("Missing tools response data");
    const data = body.data;
    const tools = Array.isArray(data) ? data : typeof data === "object" && data !== null && "tools" in data && Array.isArray(data.tools) ? data.tools : [];
    const names = tools.flatMap((tool: unknown) => typeof tool === "object" && tool !== null && "name" in tool && typeof tool.name === "string" ? [tool.name] : []);
    assert.deepEqual(names.sort(), ["list_files", "propose_edit", "read_file", "search_code"]);
  } finally {
    const cleanup = await fetch(`${baseUrl}/api/v1/settings/mcp-servers/${name}`, { method: "DELETE" });
    assert.equal(cleanup.ok, true, `Temporary connector cleanup failed: ${cleanup.status}`);
  }
}

async function checkModelRecovery(browser: Browser): Promise<void> {
  const attemptedModels: string[] = [];
  const connectorNames: string[] = [];
  let receivedArchitectureContext = false;
  let turnNumber = 0;
  let holdNextTurn = false;
  let sessionModel = '';
  const patchedModels: string[] = [];
  const retryTurnIds: unknown[] = [];
  let releaseTurn: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/settings/mcp-servers") {
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof payload !== "object" || payload === null || !("manifest" in payload)) throw new Error("Missing connector manifest");
      const manifest = payload.manifest;
      if (typeof manifest !== "object" || manifest === null || !("name" in manifest) || typeof manifest.name !== "string") throw new Error("Missing connector name");
      connectorNames.push(manifest.name);
      response.end(JSON.stringify({ data: { name: manifest.name, manifest, auth_status: { status: "authenticated" } } }));
      return;
    }
    if (request.url === "/api/v1/models") {
      response.end(JSON.stringify({ data: [{ name: "test/current" }, { name: "test/selected" }] }));
      return;
    }
    if (request.method === 'PATCH' && request.url === '/api/v1/sessions/recovered-session') {
      const patch = JSON.parse(Buffer.concat(chunks).toString()) as { agent: { spec: { model: { name: string } } } };
      sessionModel = patch.agent.spec.model.name;
      patchedModels.push(sessionModel);
      response.end(JSON.stringify({ data: { id: 'recovered-session' } }));
      return;
    }
    if (request.url === "/api/v1/sessions") {
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof payload !== "object" || payload === null || !("agent" in payload)) throw new Error("Missing agent");
      const agent = payload.agent;
      if (typeof agent !== "object" || agent === null || !("spec" in agent)) throw new Error("Missing spec");
      const spec = agent.spec;
      if (typeof spec !== "object" || spec === null || !("model" in spec)) throw new Error("Missing model");
      const model = spec.model;
      if (typeof model !== "object" || model === null || !("name" in model) || typeof model.name !== "string") throw new Error("Missing model name");
      attemptedModels.push(model.name);
      sessionModel = model.name;
      if (model.name === "test/old") {
        response.writeHead(422).end(JSON.stringify({ error: { message: "Test model mismatch" } }));
      } else {
        response.writeHead(201).end(JSON.stringify({ data: { id: "recovered-session" } }));
      }
      return;
    }
    const turnPayload: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof turnPayload === 'object' && turnPayload !== null && 'input' in turnPayload && Array.isArray(turnPayload.input)) {
      receivedArchitectureContext ||= turnPayload.input.some((message: unknown) => typeof message === 'object' && message !== null && 'content' in message && typeof message.content === 'string' && message.content.includes('Workspace source excerpts supplied by the editor'));
    }
    if (typeof turnPayload === 'object' && turnPayload !== null && 'previous_turn_id' in turnPayload) retryTurnIds.push(turnPayload.previous_turn_id);
    if (JSON.stringify(turnPayload).includes('Diff render check')) {
      const now = new Date().toISOString();
      const content = 'Proposed change:\n\n```diff\n-     return bool(val)\n+     return bool(val and val.lower() not in FALSE)\n+ <img src=x onerror="window.forgeDiffInjected=true">\n```';
      response.setHeader("Content-Type", "text/event-stream");
      response.end([{ type: 'model.message.delta', id: `dr-${++turnNumber}`, thread_id: 'main', content }, { type: 'turn.done', id: `drd-${turnNumber}`, created_at: now, thread_id: null, state: { status: 'done', completed_at: now, output: null, required_actions: [] } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    if (JSON.stringify(turnPayload).includes('Compaction check')) {
      // Event shapes as TrueForge 0.185.1 emits them when the context passes the configured input_tokens threshold.
      const now = new Date().toISOString();
      const trigger = { type: 'context_threshold_exceeded', context_tokens: 41234, threshold_tokens: 32000 };
      const events = [
        { type: 'thread.context_compaction_started', id: `cs-${++turnNumber}`, created_at: now, thread_id: 'main', trigger },
        { type: 'thread.context_compaction_finished', id: `cf-${turnNumber}`, created_at: now, thread_id: 'main', trigger, duration_ms: 2100, usage: { input_tokens: 40000, output_tokens: 900, total_tokens: 40900 } },
        { type: 'model.message.delta', id: `cm-${turnNumber}`, thread_id: 'main', content: 'Continued after compaction.', usage: { input_tokens: 5120, output_tokens: 6, input_tokens_breakdown: { harness: 200, skills: 0, instructions: 1800, tool_definitions: 1100, messages: 2020 } } },
        { type: 'turn.done', id: `cd-${turnNumber}`, created_at: now, thread_id: null, state: { status: 'done', completed_at: now, output: null, required_actions: [] } },
      ];
      response.setHeader("Content-Type", "text/event-stream");
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    if (sessionModel === 'test/broken') {
      response.setHeader("Content-Type", "text/event-stream");
      response.end(`data: ${JSON.stringify({ type: 'turn.done', id: `failed-${++turnNumber}`, created_at: new Date().toISOString(), thread_id: null, state: { status: 'error', completed_at: new Date().toISOString(), message: '[Model Error] Request failed (401): API key not valid. Please pass a valid API key.' } })}\n\n`);
      return;
    }
    if (holdNextTurn) { holdNextTurn = false; await new Promise<void>(resolve => { releaseTurn = resolve; }); }
    response.setHeader("Content-Type", "text/event-stream");
    const content = 'Recovered with the corrected model.\n\n## Architecture\n\n```mermaid\nflowchart LR\nA["Read files"] --> B["Review changes"]\n```\n\n| Component | Source |\n| --- | --- |\n| Reader | [example.txt:1](example.txt#L1) |\n\n<img src=x onerror="window.forgeInjected=true">';
    const replyId = `text-${++turnNumber}`;
    // Reasoning streams first under the same id; it must render collapsed and as plain text.
    response.end(`data: ${JSON.stringify({ type: "model.message.delta", id: replyId, thread_id: "main", reasoning_content: "Checking the <b>model</b> settings first." })}\n\ndata: ${JSON.stringify({ type: "model.message.delta", id: replyId, thread_id: "main", content })}\n\ndata: ${JSON.stringify({ type: "turn.done", id: `done-${turnNumber}`, created_at: new Date().toISOString(), thread_id: null, state: { status: "done", completed_at: new Date().toISOString(), output: null, required_actions: [] } })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No model test server port");
  try {
    const config = vscode.workspace.getConfiguration("forgeAgent");
    await config.update("baseUrl", `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Workspace);
    await config.update("model", "test/old", vscode.ConfigurationTarget.Workspace);
    const frame = await findSidebarFrame(browser);
    const input = frame.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Test failed model setup");
    await frame.getByRole("button", { name: "Send", exact: true }).click();
    await frame.getByRole("log").getByText(/Test model mismatch/).waitFor();
    await frame.locator("#message-input:not([disabled])").waitFor();
    await config.update("model", "test/current", vscode.ConfigurationTarget.Workspace);
    await input.fill("Retry with corrected settings");
    holdNextTurn = true;
    await frame.getByRole("button", { name: "Send", exact: true }).click();
    const review = frame.getByRole('region', { name: 'Proposed changes', exact: true });
    await review.locator('.review-lock').filter({ hasText: 'paused while the agent works' }).waitFor();
    assert.equal(await review.getByRole('button', { name: 'Undo last apply', exact: true }).isDisabled(), true);
    await frame.locator('#messages .thinking-indicator').filter({ hasText: 'Thinking' }).waitFor();
    const preview = review.locator('.proposal-row').filter({ hasText: 'Pending during a held turn' }).getByRole('button', { name: 'Preview', exact: true });
    assert.equal(await preview.isEnabled(), true, 'Preview must stay usable while the agent works.');
    await preview.click();
    await frame.locator('#status').filter({ hasNotText: 'Finish or cancel' }).waitFor();
    await frame.locator('body').screenshot({ path: vscode.Uri.joinPath(vscode.extensions.getExtension('mukulkumar.forge-agent')?.extensionUri ?? vscode.Uri.file('.'), 'out-test', 'review-locked.png').fsPath });
    releaseTurn?.();
    await frame.getByText("Recovered with the corrected model.", { exact: true }).waitFor();
    await frame.locator("#message-input:not([disabled])").waitFor();
    assert.equal(await frame.locator('#messages .thinking-indicator').count(), 0, 'The working line goes away when the turn ends.');
    await frame.locator('.architecture-diagram svg').waitFor();
    assert.ok((await frame.locator('.architecture-diagram svg').textContent())?.includes('Read files'));
    assert.equal(await frame.getByRole('heading', { name: 'Architecture', exact: true }).count(), 1);
    assert.equal(await frame.getByRole('table').count(), 1);
    assert.equal(await frame.getByRole('log').locator('img,script,iframe').count(), 0);
    await frame.getByRole('link', { name: 'example.txt:1', exact: true }).click();
    const navigationDeadline = Date.now() + 5_000;
    while (!vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('example.txt') && Date.now() < navigationDeadline) await setTimeout(100);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('example.txt'), true);
    assert.equal(vscode.window.activeTextEditor?.selection.start.line, 0);
    const extension = vscode.extensions.getExtension('mukulkumar.forge-agent');
    if (!extension) throw new Error('The development extension is unavailable.');
    await frame.locator('body').screenshot({ path: vscode.Uri.joinPath(extension.extensionUri, 'out-test', 'architecture-sidebar.png').fsPath });
    assert.deepEqual(attemptedModels, ["test/old", "test/current"]);
    assert.equal(connectorNames.length, 2);
    assert.ok(connectorNames.every(name => /^forge-editor-[a-f0-9]{12}$/u.test(name)));
    assert.equal(connectorNames[0], connectorNames[1]);
    await input.fill('Make an architecture map of the project');
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    await frame.locator('#message-input:not([disabled])').waitFor();
    const contextSources = frame.locator('#messages .activity-context').last().locator('xpath=..').locator('.activity-context');
    await contextSources.first().waitFor();
    assert.equal(await contextSources.count(), 3);
    assert.equal(receivedArchitectureContext, true);
    await frame.getByRole("button", { name: "Select model", exact: true }).click();
    const picker = frame.page().locator(".quick-input-widget input");
    await picker.fill("test/selected");
    await picker.press("Enter");
    await frame.locator("#status").getByText("Model: test/selected", { exact: true }).waitFor();
    assert.equal(vscode.workspace.getConfiguration("forgeAgent").get<string>("model"), "test/selected");
    await config.update('model', 'test/broken', vscode.ConfigurationTarget.Workspace);
    await config.update('fallbackModel', 'test/current', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('forgeAgent.newTask');
    await input.fill('Fallback check');
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    await frame.getByRole('log').getByText(/Switching to the fallback model/).waitFor();
    assert.equal(await frame.locator('#messages .activity-request').count(), 1, 'A new request starts a fresh context budget in the feed.');
    assert.match(await frame.locator('#messages .activity-request').innerText(), /^New request · context [\d.]+k? of 350k chars \(≈ [\d.]+k? tokens\)$/u, 'The first request of a chat counts the project overview in its budget, with an estimate in tokens.');
    await frame.getByRole('log').getByText('Recovered with the corrected model.', { exact: true }).waitFor();
    const thought = frame.locator('#messages .message-assistant details.thinking').last();
    assert.equal(await thought.locator('summary').innerText(), 'Thinking');
    assert.equal(await thought.locator('.thinking-text').textContent(), 'Checking the <b>model</b> settings first.', 'Reasoning is shown as plain text, never as HTML.');
    assert.equal(await thought.getAttribute('open'), null, 'Reasoning starts collapsed.');
    await frame.locator('#message-input:not([disabled])').waitFor();
    assert.ok((await frame.getByRole('log').innerText()).includes('API key not valid'), 'The error must be shown in plain words.');
    assert.deepEqual(patchedModels, ['test/current'], 'A non-transient error goes straight to the fallback, without retries.');
    assert.deepEqual(retryTurnIds, ['none'], 'The retry must not include the failed turn.');
    await frame.locator('body').screenshot({ path: vscode.Uri.joinPath(vscode.extensions.getExtension('mukulkumar.forge-agent')?.extensionUri ?? vscode.Uri.file('.'), 'out-test', 'model-fallback.png').fsPath });
    await input.fill('Compaction check');
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    await frame.getByText('Continued after compaction.', { exact: true }).waitFor();
    const compacted = frame.locator('#messages .activity-compaction');
    await compacted.filter({ hasText: 'summarised it to' }).waitFor();
    assert.match(await frame.locator('#messages .activity-request').last().innerText(), / · model input 5\.1k tokens$/u, 'The request row shows the input tokens TrueForge reported for the latest model call.');
    assert.match(await compacted.innerText(), /Compacted context 41k tokens reached the 32k-token threshold; TrueForge summarised it to 5.1k tokens in 2\.1 s[\s\S]*re-reads what it still needs/u);
    await frame.locator('#messages').screenshot({ path: vscode.Uri.joinPath(vscode.extensions.getExtension('mukulkumar.forge-agent')?.extensionUri ?? vscode.Uri.file('.'), 'out-test', 'compaction-feed.png').fsPath });
    await input.fill('Diff render check');
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    const removed = frame.locator('.markdown-body .diff-line-removed');
    await removed.first().waitFor();
    assert.deepEqual([await removed.count(), await frame.locator('.markdown-body .diff-line-added').count()], [1, 2]);
    assert.match(await removed.first().innerText(), /^- {5}return bool\(val\)$/u);
    const colours = await frame.evaluate(() => [...document.querySelectorAll('.markdown-body .diff-line-removed, .markdown-body .diff-line-added')].map(row => getComputedStyle(row).backgroundColor));
    assert.ok(colours.every(colour => colour !== 'rgba(0, 0, 0, 0)') && new Set(colours).size === 2, `Removed and added lines need two different backgrounds: ${colours.join(', ')}`);
    assert.equal(await frame.evaluate(() => (window as unknown as { forgeDiffInjected?: boolean }).forgeDiffInjected ?? false), false, 'HTML inside a diff block stays text.');
    await frame.locator('.markdown-body pre').last().screenshot({ path: vscode.Uri.joinPath(vscode.extensions.getExtension('mukulkumar.forge-agent')?.extensionUri ?? vscode.Uri.file('.'), 'out-test', 'approval-diff.png').fsPath });
    await config.update('fallbackModel', undefined, vscode.ConfigurationTarget.Workspace);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
