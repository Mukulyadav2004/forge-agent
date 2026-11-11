import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as vscode from 'vscode';
import { z } from 'zod';

const ResultSchema = z.object({
  matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string(), line_truncated: z.boolean() })),
  truncated: z.boolean(), candidate_limit_reached: z.boolean(), skipped_files: z.number(), eligible_files: z.number(), inspected_bytes: z.number(),
  limits: z.object({ candidate_files: z.number(), file_bytes: z.number(), total_bytes: z.number(), output_characters: z.number() }),
});

export async function checkSearch(options: { client: Client; extensionUri: vscode.Uri }): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root);
  const folder = join(root.uri.fsPath, 'search-fixtures');
  const outside = await mkdtemp(join(tmpdir(), 'forge-search-outside-'));
  await mkdir(join(folder, 'src'), { recursive: true });
  await mkdir(join(folder, 'tests'));
  await mkdir(join(folder, 'docs'));
  const files = new Map([
    ['src/cli.py', 'def register_config_command():\n    return "config-search-needle"\n'],
    ['tests/test_cli.py', 'def test_config_command():\n    assert "config-search-needle"\n'],
    ['docs/cli.rst', 'Configuration command\nconfig-search-needle documents config output.\n'],
    ['literal.txt', 'one\n-literal[pattern]\nthree\n'],
    ['long.txt', `${'λ'.repeat(1500)} centered-search-needle ${'x'.repeat(1500)}\n`],
    ['output.txt', `${'output-search-needle '.padEnd(950, 'x')}\n`.repeat(100)],
    ['raw-output.txt', 'x'.repeat(200000)],
    ['.env', 'private-search-needle\n'],
    ['oversized.txt', 'oversized-search-needle\n'.repeat(15000)],
  ]);
  const search = async (args: Record<string, unknown>) => {
    const response = await options.client.callTool({ name: 'search_code', arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    const result = ResultSchema.parse(response.structuredContent);
    const content = response.content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0]?.type, 'text');
    if (content[0]?.type === 'text') assert.deepEqual(JSON.parse(content[0].text), response.structuredContent);
    assert.ok(JSON.stringify(response.structuredContent).length <= result.limits.output_characters);
    return result;
  };
  try {
    for (const [path, text] of files) await writeFile(join(folder, path), text);
    await writeFile(join(folder, 'binary.dat'), Buffer.from('\0binary-search-needle\0'));
    await writeFile(join(folder, 'late-binary.dat'), Buffer.from('late-binary-search-needle\n\0'));
    await writeFile(join(folder, 'invalid-utf8.dat'), Buffer.from([0xff, 0x78]));
    await writeFile(join(outside, 'outside.txt'), 'outside-search-needle\n');
    await symlink(join(outside, 'outside.txt'), join(folder, 'escape.txt'));
    await symlink(join(folder, '.env'), join(folder, 'secret-alias.txt'));

    const discovered = await search({ query: 'config-search-needle', glob: 'search-fixtures/**' });
    assert.deepEqual(discovered.matches.map(match => match.path).sort(), ['search-fixtures/docs/cli.rst', 'search-fixtures/src/cli.py', 'search-fixtures/tests/test_cli.py']);
    assert.ok(discovered.matches.every(match => match.line === 2 && match.text.includes('config-search-needle')));
    assert.equal('base_revision' in discovered, false);
    assert.equal((await search({ query: 'CONFIG-SEARCH-NEEDLE', glob: 'search-fixtures/**' })).matches.length, 3);
    assert.equal((await search({ query: 'CONFIG-SEARCH-NEEDLE', glob: 'search-fixtures/**', case_sensitive: true })).matches.length, 0);
    assert.equal((await search({ query: '^def .*config_command', glob: 'search-fixtures/**/*.py', regex: true })).matches.length, 2);
    const literal = await search({ query: '-literal[pattern]', glob: 'search-fixtures/literal.txt' });
    assert.equal(literal.matches[0]?.line, 2);
    assert.equal(literal.matches[0]?.text, '-literal[pattern]');
    const long = await search({ query: 'centered-search-needle', glob: 'search-fixtures/long.txt' });
    assert.ok(long.matches[0]?.text.includes('centered-search-needle'));
    assert.equal(long.matches[0]?.line_truncated, true);
    const capped = await search({ query: 'config-search-needle', glob: 'search-fixtures/**', max_results: 1 });
    assert.equal(capped.matches.length, 1);
    assert.equal(capped.truncated, true);
    const output = await search({ query: 'output-search-needle', glob: 'search-fixtures/output.txt', max_results: 100 });
    assert.ok(output.matches.length > 0 && output.matches.length < 100);
    assert.equal(output.truncated, true);
    const rawOutput = await search({ query: 'x', glob: 'search-fixtures/raw-output.txt' });
    assert.equal(rawOutput.truncated, true);
    const noMatch = await search({ query: 'absent-search-needle', glob: 'search-fixtures/src/**' });
    assert.equal(noMatch.matches.length, 0);
    assert.equal(noMatch.truncated, false);
    for (const query of ['private-search-needle', 'outside-search-needle', 'binary-search-needle', 'late-binary-search-needle', 'oversized-search-needle']) {
      assert.equal((await search({ query, glob: 'search-fixtures/**' })).matches.length, 0, query);
    }
    const invalidUtf8 = await search({ query: 'x', glob: 'search-fixtures/invalid-utf8.dat' });
    assert.equal(invalidUtf8.matches.length, 0);
    assert.equal(invalidUtf8.skipped_files, 1);
    for (const args of [{ query: '[', regex: true }, { query: 'x', glob: '../**' }, { query: 'x', max_results: 101 }]) {
      assert.equal((await options.client.callTool({ name: 'search_code', arguments: args })).isError, true);
    }
    const secretRead = await options.client.callTool({ name: 'read_file', arguments: { path: 'search-fixtures/secret-alias.txt' } });
    assert.equal(secretRead.isError, true, 'Canonical realpath validation must also reject secret aliases for reads.');

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(folder, 'src/cli.py')));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), '# unsaved-search-needle\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const dirty = await search({ query: 'config-search-needle', glob: 'search-fixtures/src/**' });
    assert.equal(dirty.matches.length, 0);
    assert.equal(dirty.skipped_files, 1);
    assert.equal(dirty.truncated, true);
    const current = await options.client.callTool({ name: 'read_file', arguments: { path: 'search-fixtures/src/cli.py' } });
    assert.ok(JSON.stringify(current).includes('unsaved-search-needle'));
    const undo = new vscode.WorkspaceEdit();
    undo.delete(document.uri, new vscode.Range(0, 0, 1, 0));
    assert.equal(await vscode.workspace.applyEdit(undo), true);
    assert.equal(await document.save(), true);

    await mkdir(join(folder, 'budget'));
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(folder, 'budget', `${index}.txt`), `${'b'.repeat(240000)}\n`)));
    const bytes = await search({ query: 'not-present', glob: 'search-fixtures/budget/**' });
    assert.ok(bytes.inspected_bytes <= bytes.limits.total_bytes);
    assert.ok(bytes.skipped_files > 0);
    assert.equal(bytes.truncated, true);
    await rm(join(folder, 'budget'), { recursive: true });
    await mkdir(join(folder, 'candidates'));
    await Promise.all(Array.from({ length: 1005 }, (_, index) => writeFile(join(folder, 'candidates', `${index}.txt`), 'candidate-search-needle\n')));
    const candidates = await search({ query: 'not-present', glob: 'search-fixtures/candidates/**' });
    assert.equal(candidates.candidate_limit_reached, true);
    assert.ok(candidates.eligible_files <= candidates.limits.candidate_files);
    const abort = new AbortController();
    const cancelled = options.client.callTool({ name: 'search_code', arguments: { query: 'candidate-search-needle', glob: 'search-fixtures/candidates/**' } }, undefined, { signal: abort.signal });
    abort.abort();
    await assert.rejects(cancelled);
    assert.equal((await search({ query: '-literal[pattern]', glob: 'search-fixtures/literal.txt' })).matches.length, 1);

    for (const [path, text] of files) assert.equal(await readFile(join(folder, path), 'utf8'), text, `Search must not write ${path}.`);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(options.extensionUri, 'out-test', 'search-result.json'), new TextEncoder().encode(JSON.stringify({ passed: true, native_mcp: true, discovered_source_test_docs: true, literal_regex_case_and_dash_patterns: true, bounded_results_lines_bytes_candidates: true, secrets_symlinks_binary_oversized_dirty_excluded: true, current_buffer_read_preserved: true, invalid_inputs_refused: true, cancelled_request_recovered: true, no_source_writes: true, live_model: false }, null, 2)));
    console.log('Search checks passed: native MCP discovery, bounds, exclusions, cancellation and no source writes.');
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}
