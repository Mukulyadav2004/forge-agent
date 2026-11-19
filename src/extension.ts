import * as vscode from "vscode";
import { EditorBridge } from "./tools/EditorBridge";
import { AgentViewProvider } from "./sidebar/AgentViewProvider";
import { WorkspaceFiles } from './workspace/WorkspaceFiles';
import { VscodeEditBackend } from './edits/VscodeEditBackend';
import { EditService } from './edits/EditService';
import { ToolLog } from './observability/events';
import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { ForgeSession } from './agent/ForgeSession';

let toolLog: ToolLog | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const files = new WorkspaceFiles();
  toolLog = new ToolLog({
    directory: vscode.workspace.getWorkspaceFolder(context.globalStorageUri) ? undefined : vscode.Uri.joinPath(context.globalStorageUri, 'observability').fsPath,
    workspaceRoots: vscode.workspace.workspaceFolders?.filter(root => root.uri.scheme === 'file').map(root => root.uri.fsPath),
    resolvePath: async path => {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) throw new Error('Workspace unavailable.');
      // locate applies the same containment and secret rules as resolve, and also names a new file write_file will create.
      const located = await files.locate(path);
      return located.kind === 'missing' ? located.relative : relative(await realpath(root.uri.fsPath), located.realPath).split(sep).join('/');
    },
    onFailure: () => { void vscode.window.showWarningMessage('Forge event logging is unavailable. Editor tools can continue; this run has incomplete measurement.'); },
  });
  const backend = new VscodeEditBackend({ files, storageUri: context.globalStorageUri });
  ForgeSession.observe = event => toolLog?.recordSession(event);
  const editChanges = new vscode.EventEmitter<void>();
  const edits = new EditService({ backend, onChange: () => editChanges.fire() });
  const bridge = new EditorBridge({ files, edits, log: toolLog });
  const bridgeReady = bridge.start();
  void bridgeReady.catch((error: unknown) => vscode.window.showErrorMessage(`Forge MCP: ${error instanceof Error ? error.message : "Start failed"}`));
  const provider = new AgentViewProvider(context.extensionUri, {
    getEditorManifest: async (namePrefix: string) => {
      await bridgeReady;
      return bridge.getManifest({ namePrefix });
    },
    openFile: options => bridge.openFile(options),
    architectureContext: () => bridge.architectureContext(),
    projectOverview: () => bridge.projectOverview(),
    projectInstructions: () => bridge.projectInstructions(),
    prepareEdit: (name, argumentsJson) => bridge.prepareEdit(name, argumentsJson),
    settleEdits: allow => bridge.settleEdits(allow),
    beginRequest: (scope, requestText) => bridge.beginRequest(scope, requestText),
    finishChecklist: () => bridge.finishChecklist(),
    openRequirements: () => bridge.openRequirements(),
    lastCommandResult: () => bridge.lastCommandResult(),
    commandsLeft: () => bridge.commandsLeft(),
    guardDeny: (name, argumentsJson, reason) => bridge.guardDeny(name, argumentsJson, reason),
    edits,
  });
  context.subscriptions.push(bridge.onDidActivity(entry => provider.recordActivity(entry)));
  context.subscriptions.push(backend, editChanges, editChanges.event(() => provider.refreshReview()));
  context.subscriptions.push(
    vscode.commands.registerCommand('forgeAgent.applyAll', () => provider.review({ action: 'apply_all' })),
    vscode.commands.registerCommand('forgeAgent.rejectAll', () => provider.review({ action: 'reject_all' })),
    vscode.commands.registerCommand('forgeAgent.undo', () => provider.review({ action: 'undo' })),
  );
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

export async function deactivate(): Promise<void> { ForgeSession.observe = () => undefined; await toolLog?.flush().catch(() => undefined); }
