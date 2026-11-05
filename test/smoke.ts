import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

  await vscode.commands.executeCommand("forgeAgent.open");

  const port = process.env.FORGE_SMOKE_CDP_PORT;
  if (port === undefined || !/^\d+$/.test(port)) {
    throw new Error("The sidebar smoke check needs a local debugging port.");
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const frame = await findSidebarFrame(browser);
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
  await vscode.commands.executeCommand("forgeAgent.copyMcp");
  const connection: unknown = JSON.parse(await vscode.env.clipboard.readText());
  if (typeof connection !== "object" || connection === null || !("url" in connection) || typeof connection.url !== "string" || !("headers" in connection) || typeof connection.headers !== "object" || connection.headers === null || !("Authorization" in connection.headers) || typeof connection.headers.Authorization !== "string") throw new Error("Invalid MCP connection details");
  const client = new Client({ name: "forge-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: connection.headers.Authorization } } }));
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 3);
  const read = await client.callTool({ name: "read_file", arguments: { path: "example.txt" } });
  assert.equal(read.isError, undefined);
  assert.ok(JSON.stringify(read).includes("original text"));
  const escape = await client.callTool({ name: "read_file", arguments: { path: "../outside.txt" } });
  assert.equal(escape.isError, true);
  await client.callTool({ name: "propose_edit", arguments: { path: "example.txt", new_text: "proposed text", explanation: "Smoke test" } });
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "example.txt"))), "original text\n");
  await client.close();
  const denied = await fetch(connection.url, { method: "POST" });
  assert.equal(denied.status, 403);
  await vscode.env.clipboard.writeText(previousClipboard);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extension.extensionUri, "out-test", "mcp-result.json"), new TextEncoder().encode(JSON.stringify({ authenticated_tools: true, bounded_read: true, traversal_denied: true, proposal_no_write: true, unauthorized_denied: true })));
  console.log("MCP checks passed: authentication, tools, reads, traversal denial, proposal leaves disk unchanged.");
  console.log(`Smoke check passed: ${extension.id} exchanges sidebar messages and preserves drafts.`);
  await browser.close();
}
