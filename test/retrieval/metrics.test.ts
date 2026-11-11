import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureTrace } from './metrics';

const targets = ['tests/test_cli.py', 'docs/cli.rst'];
const call = (options: { id: string; name: string; args: object }) => ({ type: 'model.message', tool_calls: [{ id: options.id, tool_info: { name: options.name }, function: { name: options.name, arguments: JSON.stringify(options.args) } }] });
const response = (options: { id: string; content: object }) => ({ type: 'tool.response', tool_call_id: options.id, content: JSON.stringify(options.content) });

test('baseline metrics correlate responses before calls and count returned characters once', () => {
  const result = response({ id: 'search', content: { matches: [{ path: targets[0] }, { path: targets[0] }, { path: targets[1] }], truncated: true } });
  const read = response({ id: 'read', content: { path: targets[0], base_revision: 'receipt', text: 'λ', start_line: 1, end_line: 1 } });
  const report = measureTrace({ events: [result, read, call({ id: 'read', name: 'read_file', args: { path: targets[0] } }), call({ id: 'search', name: 'search_code', args: { query: 'command' } })], targets });
  assert.equal(report.search_calls, 1);
  assert.equal(report.search_results[0]?.returned_matches, 3);
  assert.deepEqual(report.files_read, [targets[0]]);
  assert.equal(report.characters_returned.all_tools, result.content.length + read.content.length);
  assert.deepEqual(report.targets[targets[1]], { appeared_in_results: true, read: false });
});

test('failed reads and assistant claims never count as successful file inspection', () => {
  const report = measureTrace({ events: [call({ id: 'read', name: 'read_file', args: { path: targets[0] } }), response({ id: 'read', content: { isError: true, path: targets[0], text: 'not read', base_revision: 'invalid' } }), { type: 'model.message', content: `I read ${targets.join(' and ')}` }], targets });
  assert.equal(report.read_calls, 1);
  assert.deepEqual(report.files_read, []);
  assert.ok(Object.values(report.targets).every(target => !target.read && !target.appeared_in_results));
});

test('grouped search results can be compared with the same baseline instrument', () => {
  const report = measureTrace({ events: [call({ id: 'search', name: 'search_code', args: { query: 'command' } }), response({ id: 'search', content: { files: [{ path: targets[1], matches: [{ line: 1 }, { line: 2 }] }] } })], targets });
  assert.equal(report.search_results[0]?.returned_matches, 2);
  assert.deepEqual(report.targets[targets[1]], { appeared_in_results: true, read: false });
});
