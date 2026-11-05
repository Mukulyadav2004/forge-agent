import * as vscode from "vscode";
import { EditorBridge } from "./tools/EditorBridge";
import { AgentViewProvider } from "./sidebar/AgentViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const bridge = new EditorBridge();
  void bridge.start().catch((error: unknown) => vscode.window.showErrorMessage(`Forge MCP: ${error instanceof Error ? error.message : "Start failed"}`));
  const provider = new AgentViewProvider(context.extensionUri);
  const viewRegistration = vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, provider);
  const openAgent = vscode.commands.registerCommand("forgeAgent.open", async () => {
    await vscode.commands.executeCommand(`${AgentViewProvider.viewType}.focus`);
  });

  const statusButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusButton.text = "$(code) Forge Agent";
  statusButton.tooltip = "Open the Forge Agent sidebar";
  statusButton.command = "forgeAgent.open";
  statusButton.show();

  context.subscriptions.push(vscode.commands.registerCommand("forgeAgent.editSelection", () => provider.editSelection()), bridge, vscode.commands.registerCommand("forgeAgent.copyMcp", () => bridge.copyConnection()), vscode.commands.registerCommand("forgeAgent.newTask", () => provider.newTask()), provider, viewRegistration, openAgent, statusButton);
}
