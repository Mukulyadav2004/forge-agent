import { readFile, realpath, stat } from 'node:fs/promises';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type { FileSnapshot } from '../edits/EditService';
import { contentHash, MAX_EDIT_CHARACTERS } from '../edits/EditService';

const UNAVAILABLE_PATH = /(^|[/\\])(\.env(?:\.[^/\\]+)?|\.git|id_rsa|id_ed25519)([/\\]|$)/i;

export class WorkspaceFiles {
  async open(path: string): Promise<vscode.TextDocument> {
    const resolved = await this.resolve(path);
    const aliases = this.documentsFor(resolved.realPath);
    const dirty = aliases.filter(document => document.isDirty);
    if (dirty.length > 1 && dirty.some(document => document.getText() !== dirty[0]?.getText())) throw new Error('This file has conflicting unsaved editor aliases. Save or close them first.');
    const document = dirty[0] ?? aliases.find(candidate => candidate.uri.toString() === resolved.uri.toString()) ?? await vscode.workspace.openTextDocument(resolved.uri);
    if (document.getText().length > MAX_EDIT_CHARACTERS) throw new Error('File is too large for this tool.');
    return document;
  }
  private documentsFor(realPath: string): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter(document => {
      if (document.uri.scheme !== 'file' || document.isClosed) return false;
      try { return realpathSync(document.uri.fsPath) === realPath; } catch { return false; }
    });
  }
  async resolve(path: string): Promise<{ realPath: string; uri: vscode.Uri; size: number; dirty: boolean }> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root || root.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace first.');
    if (isAbsolute(path) || UNAVAILABLE_PATH.test(path)) throw new Error('This path is not available to the agent.');
    const rootPath = await realpath(root.uri.fsPath);
    const filePath = await realpath(resolve(rootPath, path));
    const rel = relative(rootPath, filePath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path is outside the workspace.');
    if (UNAVAILABLE_PATH.test(rel)) throw new Error('This path is not available to the agent.');
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error('Only existing regular text files are supported.');
    return { realPath: filePath, uri: vscode.Uri.file(resolve(root.uri.fsPath, path)), size: metadata.size, dirty: this.documentsFor(filePath).some(document => document.isDirty) };
  }
  async capture(path: string): Promise<FileSnapshot> {
    const document = await this.open(path);
    const { realPath } = await this.resolve(path);
    const bytes = await readFile(realPath);
    const metadata = await stat(realPath);
    let diskText: string;
    try { diskText = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new Error('Only UTF-8 text files are supported for reviewed edits.', { cause: error }); }
    if (diskText.includes('\0')) throw new Error('Binary files cannot be edited through proposals.');
    const text = document.getText();
    if (!document.isDirty && diskText !== text) throw new Error(`${path} changed on disk. Reload the file before requesting another proposal.`);
    return { path, realPath, documentUri: document.uri.toString(), identity: `${metadata.dev}:${metadata.ino}`, text, bytes: Uint8Array.from(bytes), version: document.version, dirty: document.isDirty, eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' };
  }
  canReplace(snapshot: FileSnapshot): boolean {
    try {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root || !vscode.workspace.isTrusted || realpathSync(resolve(root.uri.fsPath, snapshot.path)) !== snapshot.realPath) return false;
      const aliases = this.documentsFor(snapshot.realPath);
      if (aliases.some(document => document.uri.toString() !== snapshot.documentUri && document.isDirty)) return false;
      const document = aliases.find(candidate => candidate.uri.toString() === snapshot.documentUri);
      if (!document || document.version !== snapshot.version || document.getText() !== snapshot.text || document.isDirty !== snapshot.dirty) return false;
      accessSync(snapshot.realPath, constants.W_OK);
      const metadata = statSync(snapshot.realPath);
      return `${metadata.dev}:${metadata.ino}` === snapshot.identity && contentHash(readFileSync(snapshot.realPath)) === contentHash(snapshot.bytes);
    } catch { return false; }
  }
}
