import test from 'node:test';
import assert from 'node:assert/strict';

// Live-run misses of propose_edit old_text, one case each, as the model sends them after reading the file.
const { replaceMatched } = await import('../../out/edits/EditService.js');
const textarea = '<textarea id="message-input" rows="4" placeholder="Ask Forge, or attach a selection with Ctrl+L" spellcheck="false" title="Ctrl+Enter sends"></textarea>';
const press = 'await input.press("Meta+Enter");';

test('a CRLF file matches LF old_text and keeps its CRLF endings', () => {
  const result = replaceMatched({ source: `  <div>\r\n      ${textarea}\r\n  </div>\r\n`, oldText: `<div>\n      ${textarea}`, newText: `<div>\n      ${textarea.replace('Ctrl+Enter sends', 'Enter sends')}` });
  assert.equal(result.ok, true);
  assert.equal(result.text, `  <div>\r\n      ${textarea.replace('Ctrl+Enter sends', 'Enter sends')}\r\n  </div>\r\n`);
});

test('a CRLF file matches CRLF old_text', () => {
  const result = replaceMatched({ source: `a\r\n  ${press}\r\nb\r\n`, oldText: `a\r\n  ${press}\r\n`, newText: 'a\r\n  await input.press("Enter");\r\n' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'a\r\n  await input.press("Enter");\r\nb\r\n');
});

test('a line with trailing spaces in the file matches old_text without them', () => {
  const result = replaceMatched({ source: `  await input.fill(x);   \n  ${press}  \n`, oldText: `  await input.fill(x);\n  ${press}`, newText: '  await input.fill(x);\n  await input.press("Enter");' });
  assert.equal(result.ok, true);
});

test('a tab-indented file matches old_text indented with spaces', () => {
  const result = replaceMatched({ source: `function f() {\n\tif (x) {\n\t\t${press}\n\t}\n}\n`, oldText: `  if (x) {\n    ${press}\n  }`, newText: '  if (x) {\n    await input.press("Enter");\n  }' });
  assert.equal(result.ok, true, 'Indentation differs only in tabs versus spaces.');
  assert.equal(result.text, 'function f() {\n\tif (x) {\n\t\tawait input.press("Enter");\n\t}\n}\n', 'The file keeps its tabs.');
});

test('a single line matches old_text with no indentation', () => {
  const result = replaceMatched({ source: `      ${textarea}\n`, oldText: textarea, newText: textarea.replace('Ctrl+Enter sends', 'Enter sends') });
  assert.equal(result.ok, true);
});

test('old_text copied with read_file line-number prefixes ("123: ") matches', () => {
  const result = replaceMatched({ source: `  await input.fill(x);\n  ${press}\n`, oldText: `100:   await input.fill(x);\n101:   ${press}`, newText: '  await input.fill(x);\n  await input.press("Enter");' });
  assert.equal(result.ok, true);
});

test('old_text copied with tab-separated line-number prefixes ("123\\t") matches', () => {
  const result = replaceMatched({ source: `  ${press}\n`, oldText: `101\t  ${press}`, newText: '  await input.press("Enter");' });
  assert.equal(result.ok, true);
});

test('old_text with JSON-escaped quotes (\\") is refused with a double-escape message, never unescaped', () => {
  const result = replaceMatched({ source: `      ${textarea}\n`, oldText: textarea.replaceAll('"', '\\"'), newText: textarea.replace('Ctrl+Enter sends', 'Enter sends') });
  assert.equal(result.ok, false);
  assert.match(result.hint, /^Your old_text looks double-escaped \(\\" or \\n\)\. Send the text exactly as it appears in the file, with plain quotes and real line breaks\./u);
  const newline = replaceMatched({ source: 'a\nb\n', oldText: 'a\\nb', newText: 'a\nc' });
  assert.match(newline.hint, /looks double-escaped/u, 'A literal \\n where the file has a line break is reported the same way.');
  const real = replaceMatched({ source: 'print("a\\nb")\n', oldText: 'print("a\\nc")', newText: 'x' });
  assert.doesNotMatch(real.hint ?? '', /double-escaped/u, 'A \\n the file itself contains is code, not double escaping.');
});

test('Python: a method copied at column 0 is re-indented into its class, so the code still runs as a method', () => {
  const source = 'class Greeter:\n    def greet(self, name):\n        if name:\n            return "hi " + name\n        return "hi"\n\n    def other(self):\n        return 0\n';
  const result = replaceMatched({ source, oldText: 'def greet(self, name):\n    if name:\n        return "hi " + name\n    return "hi"', newText: 'def greet(self, name):\n    if name:\n        name = name.strip()\n        return "hi " + name\n    return "hi"' });
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'indent');
  assert.equal(result.text, 'class Greeter:\n    def greet(self, name):\n        if name:\n            name = name.strip()\n            return "hi " + name\n        return "hi"\n\n    def other(self):\n        return 0\n',
    'Every line moves by the same 4 spaces; left at column 0, greet would leave the class and other() would break.');
});

test('Python: old_text indented in 2-space steps maps onto a 4-space file step by step', () => {
  const source = 'def f(x):\n    if x:\n        return 1\n    return 0\n';
  const result = replaceMatched({ source, oldText: 'if x:\n  return 1', newText: 'if x:\n  y = x * 2\n  return y' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'def f(x):\n    if x:\n        y = x * 2\n        return y\n    return 0\n');
});

test('indentation tolerance refuses when the block appears in more than one place', () => {
  const source = 'def a():\n    if x:\n        run()\n\ndef b():\n    if x:\n        run()\n';
  const result = replaceMatched({ source, oldText: 'if x:\n  run()', newText: 'if x:\n  stop()' });
  assert.deepEqual(result, { ok: false, count: 2 });
});

test('indentation tolerance gives no match when new_text cannot be mapped (a line less indented than old_text)', () => {
  const source = 'def f():\n    if x:\n        run()\n';
  const result = replaceMatched({ source, oldText: '  if x:\n    run()', newText: 'if x:\n    run()' });
  assert.equal(result.ok, false);
});

test('a CRLF file with tabs keeps CRLF and tabs after an indentation-tolerant match', () => {
  const result = replaceMatched({ source: 'f() {\r\n\tif (x) {\r\n\t\trun();\r\n\t}\r\n}\r\n', oldText: 'if (x) {\n    run();\n}', newText: 'if (x) {\n    stop();\n}' });
  assert.equal(result.text, 'f() {\r\n\tif (x) {\r\n\t\tstop();\r\n\t}\r\n}\r\n');
});

test('line-number prefixes are stripped from new_text too when every line has them', () => {
  const result = replaceMatched({ source: '  a\n  b\n', oldText: '1:   a\n2:   b', newText: '1:   a\n2:   c' });
  assert.equal(result.text, '  a\n  c\n');
});

test('line-number prefixes are not stripped when the format or the numbering is inconsistent', () => {
  assert.equal(replaceMatched({ source: '  a\n  b\n', oldText: '1:   a\n2\t  b', newText: 'x' }).ok, false, 'Mixed "1: " and "2\\t" formats.');
  assert.equal(replaceMatched({ source: '  a\n  b\n', oldText: '1:   a\n5:   b', newText: 'x' }).ok, false, 'Numbers that are not consecutive are content, not read_file output.');
  assert.equal(replaceMatched({ source: '1: a\n2: b\n', oldText: '1: a\n2: b', newText: '1: a\n2: c' }).text, '1: a\n2: c\n', 'Text that really starts with numbers matches as written first.');
});
