import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { EditPreviewContentStore, EDIT_PREVIEW_URI_SCHEME, VscodeEditPreview } from '../editor/ClineEditPreview';
import { WorkspaceFiles } from '../workspace/WorkspaceFiles';
import { contentHash } from './EditService';
import type { EditBackend, FileSnapshot, Replacement } from './EditService';

export class VscodeEditBackend implements EditBackend, vscode.Disposable {
  private readonly contentStore = new EditPreviewContentStore();
  private readonly previews = new Map<string, VscodeEditPreview>();
  private readonly registration: vscode.Disposable;
  constructor(private readonly options: { files: WorkspaceFiles; storageUri: vscode.Uri }) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(EDIT_PREVIEW_URI_SCHEME, this.contentStore);
  }
  capture(path: string): Promise<FileSnapshot> { return this.options.files.capture(path); }
  async replace(changes: Replacement[]): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const change of changes) {
      const uri = vscode.Uri.parse(change.before.documentUri);
      const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
      if (!document || !this.options.files.canReplace(change.before)) return false;
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), change.text);
    }
    return vscode.workspace.applyEdit(edit, { isRefactoring: true });
  }
  async save(path: string): Promise<boolean> { return (await this.options.files.open(path)).save(); }
  async backup(options: { id: string; files: FileSnapshot[] }): Promise<string> {
    const directory = vscode.Uri.joinPath(this.options.storageUri, 'edit-snapshots');
    await mkdir(directory.fsPath, { recursive: true, mode: 0o700 });
    const target = vscode.Uri.joinPath(directory, `${options.id}-${randomUUID()}.json`);
    const data = { version: 1, transaction_id: options.id, created_at: new Date().toISOString(), files: options.files.map(file => ({ path: file.path, real_path: file.realPath, sha256: contentHash(file.bytes), content_base64: Buffer.from(file.bytes).toString('base64') })) };
    await writeFile(target.fsPath, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    return target.fsPath;
  }
  async preview(options: { id: string; path: string; before: string; after: string }): Promise<void> {
    let preview = this.previews.get(options.id);
    if (!preview) { preview = new VscodeEditPreview(this.contentStore); this.previews.set(options.id, preview); }
    await preview.open({ title: `Forge proposal: ${options.path}`, displayPath: options.path, leftContent: options.before, rightContent: options.after });
  }
  async closePreview(id: string): Promise<void> {
    const preview = this.previews.get(id);
    this.previews.delete(id);
    await preview?.close();
  }
  dispose(): void {
    for (const preview of this.previews.values()) void preview.close().catch(() => undefined);
    this.previews.clear(); this.registration.dispose(); this.contentStore.dispose();
  }
}
