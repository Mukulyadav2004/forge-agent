import * as vscode from "vscode";
import { EditorBridge } from "./tools/EditorBridge";
import { AgentViewProvider } from "./sidebar/AgentViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const bridge = new EditorBridge();
  const bridgeReady = bridge.start();
  void bridgeReady.catch((error: unknown) => vscode.window.showErrorMessage(`Forge MCP: ${error instanceof Error ? error.message : "Start failed"}`));
  const provider = new AgentViewProvider(context.extensionUri, {
    getEditorManifest: async (namePrefix: string) => {
      await bridgeReady;
      return bridge.getManifest({ namePrefix });
    },
    openFile: options => bridge.openFile(options),
    architectureContext: () => bridge.architectureContext(),
  });
  context.subscriptions.push(bridge.onDidReadFile(file => provider.recordInspection(file)));
  const viewRegistration = vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, provider);
  const openAgent = vscode.commands.registerCommand("forgeAgent.open", async () => {
    await vscode.commands.executeCommand(`${AgentViewProvider.viewType}.focus`);
  });

  const statusButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusButton.text = "$(code) Forge Agent";
  statusButton.tooltip = "Open the Forge Agent sidebar";
  statusButton.command = "forgeAgent.open";
  statusButton.show();

  const copyMcp = vscode.commands.registerCommand("forgeAgent.copyMcp", async () => {
    try {
      await bridgeReady;
      await bridge.copyConnection();
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(`Could not copy the editor MCP connection: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  context.subscriptions.push(vscode.commands.registerCommand("forgeAgent.selectModel", () => provider.selectModel()), vscode.commands.registerCommand("forgeAgent.editSelection", () => provider.editSelection()), bridge, copyMcp, vscode.commands.registerCommand("forgeAgent.newTask", () => provider.newTask()), provider, viewRegistration, openAgent, statusButton);
}
