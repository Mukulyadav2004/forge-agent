import { checkEditorTransactions } from './edits/realEditor';
import { checkReviewFeedback } from './sidebar/reviewFeedback';
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
  assert.equal(await restoredFrame.getByText("Hello Forge!", { exact: true }).count(), 1);
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
  assert.equal(listed.tools.length, 3);
  const read = await client.callTool({ name: "read_file", arguments: { path: "example.txt" } });
  assert.equal(read.isError, undefined);
  assert.ok(JSON.stringify(read).includes("original text"));
  const structuredRead: unknown = read.structuredContent;
  assert.ok(typeof structuredRead === 'object' && structuredRead !== null && 'text' in structuredRead && typeof structuredRead.text === 'string' && structuredRead.text.includes('original text'), 'TrueForge must receive the file text even when it selects only structuredContent.');
  await restoredFrame.locator('#file-evidence summary').click();
  await restoredFrame.getByRole('button', { name: 'example.txt:1-2', exact: true }).waitFor();
  const escape = await client.callTool({ name: "read_file", arguments: { path: "../outside.txt" } });
  assert.equal(escape.isError, true);
  const readData: unknown = read.structuredContent;
  if (typeof readData !== 'object' || readData === null || !('base_revision' in readData) || typeof readData.base_revision !== 'string') throw new Error('read_file must return a base revision.');
  const baseRevision = readData.base_revision;
  const proposal = await client.callTool({ name: "propose_edit", arguments: { path: "example.txt", base_revision: baseRevision, new_text: "proposed text", explanation: "Smoke test" } });
  assert.equal(proposal.isError, undefined);
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "example.txt"))), "original text\n");
  await checkEditorTransactions({ client, frame: restoredFrame, extensionUri: extension.extensionUri });
  await checkReviewFeedback({ client, frame: restoredFrame, extensionUri: extension.extensionUri });
  await client.close();
  const denied = await fetch(connection.url, { method: "POST" });
  assert.equal(denied.status, 403);
  if (process.env.FORGE_SMOKE_LIVE_REGISTRY === "true") {
    await checkLiveRegistry({ url: connection.url, authorization: connection.headers.Authorization });
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extension.extensionUri, "out-test", "live-editor-result.json"), new TextEncoder().encode(JSON.stringify({ registration: true, trueforge_discovers_editor_tools: true })));
  }
  await vscode.env.clipboard.writeText(previousClipboard);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extension.extensionUri, "out-test", "mcp-result.json"), new TextEncoder().encode(JSON.stringify({ authenticated_tools: true, bounded_read: true, traversal_denied: true, proposal_no_write: true, unauthorized_denied: true })));
  await checkModelRecovery(browser);
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
    assert.deepEqual(names.sort(), ["list_files", "propose_edit", "read_file"]);
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
    response.setHeader("Content-Type", "text/event-stream");
    const content = 'Recovered with the corrected model.\n\n## Architecture\n\n```mermaid\nflowchart LR\nA["Read files"] --> B["Review changes"]\n```\n\n| Component | Source |\n| --- | --- |\n| Reader | [example.txt:1](example.txt#L1) |\n\n<img src=x onerror="window.forgeInjected=true">';
    response.end(`data: ${JSON.stringify({ type: "model.message.delta", id: `text-${++turnNumber}`, thread_id: "main", content })}\n\ndata: ${JSON.stringify({ type: "turn.done", id: `done-${turnNumber}`, created_at: new Date().toISOString(), thread_id: null, state: { status: "done", completed_at: new Date().toISOString(), output: null, required_actions: [] } })}\n\n`);
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
    await frame.getByRole("button", { name: "Send", exact: true }).click();
    await frame.getByText("Recovered with the corrected model.", { exact: true }).waitFor();
    await frame.locator("#message-input:not([disabled])").waitFor();
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
    const contextSources = frame.locator('#file-evidence-list button').filter({ hasText: 'supplied context' });
    await contextSources.first().waitFor();
    assert.equal(await contextSources.count(), 3);
    assert.equal(receivedArchitectureContext, true);
    await frame.getByRole("button", { name: "Select model", exact: true }).click();
    const picker = frame.page().locator(".quick-input-widget input");
    await picker.fill("test/selected");
    await picker.press("Enter");
    await frame.locator("#status").getByText("Model: test/selected", { exact: true }).waitFor();
    assert.equal(vscode.workspace.getConfiguration("forgeAgent").get<string>("model"), "test/selected");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
