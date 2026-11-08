// @license Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0.
// Modified for Forge Agent: scoped stores, immediate rendering, and transaction-owned lifetime.
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export const EDIT_PREVIEW_URI_SCHEME = 'forge-edit-preview';

export class EditPreviewContentStore implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? ''; }
  set(options: { uri: vscode.Uri; content: string }): void {
    this.contents.set(options.uri.toString(), options.content);
    this.emitter.fire(options.uri);
  }
  delete(uri: vscode.Uri): void { this.contents.delete(uri.toString()); }
  dispose(): void { this.contents.clear(); this.emitter.dispose(); }
}

export class VscodeEditPreview {
  private leftUri: vscode.Uri | undefined;
  private rightUri: vscode.Uri | undefined;
  constructor(private readonly contentStore: EditPreviewContentStore) {}
  async open(content: { title: string; displayPath: string; leftContent: string; rightContent: string }): Promise<void> {
    await this.close();
    const previewId = randomUUID();
    this.leftUri = vscode.Uri.from({ scheme: EDIT_PREVIEW_URI_SCHEME, path: `/${content.displayPath}`, query: `${previewId}-left` });
    this.rightUri = vscode.Uri.from({ scheme: EDIT_PREVIEW_URI_SCHEME, path: `/${content.displayPath}`, query: `${previewId}-right` });
    this.contentStore.set({ uri: this.leftUri, content: content.leftContent });
    this.contentStore.set({ uri: this.rightUri, content: content.rightContent });
    await vscode.commands.executeCommand('vscode.diff', this.leftUri, this.rightUri, content.title, { preview: false, preserveFocus: true });
  }
  async close(): Promise<void> {
    const leftUri = this.leftUri;
    const rightUri = this.rightUri;
    this.leftUri = undefined;
    this.rightUri = undefined;
    if (!leftUri || !rightUri) return;
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === leftUri.toString() && tab.input.modified.toString() === rightUri.toString());
      for (const tab of tabs) await vscode.window.tabGroups.close(tab);
    } finally {
      this.contentStore.delete(leftUri);
      this.contentStore.delete(rightUri);
    }
  }
}
