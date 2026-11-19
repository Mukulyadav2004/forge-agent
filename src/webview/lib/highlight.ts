import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** A curated set of common languages; anything else stays plain text. Diff and Mermaid blocks have their own renderers. */
for (const [name, language] of Object.entries({ bash, c, cpp, csharp, css, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, plaintext, powershell, python, ruby, rust, scss, sql, swift, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}
hljs.registerAliases(['shell', 'console', 'terminal'], { languageName: 'bash' });
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });
hljs.registerAliases(['vue', 'svelte'], { languageName: 'xml' });

const MAX_HIGHLIGHT_CHARACTERS = 100_000;

/** Colours one `<code class="language-x">` block. The highlighter escapes the source and adds only class-bearing spans, which DOMPurify enforces. */
export function highlightCode(code: HTMLElement): void {
  const language = /(?:^|\s)language-([\w#+.-]+)/u.exec(code.className)?.[1]?.toLowerCase();
  const source = code.textContent ?? '';
  if (!language || !hljs.getLanguage(language) || source.length > MAX_HIGHLIGHT_CHARACTERS) return;
  const { value } = hljs.highlight(source, { language, ignoreIllegals: true });
  code.innerHTML = DOMPurify.sanitize(value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
  code.classList.add('hljs');
}
