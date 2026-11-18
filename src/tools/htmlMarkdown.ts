// A small HTML to Markdown/text converter for web_fetch. opencode (MIT) uses htmlparser2 in
// packages/core/src/tool/html-markdown.ts; Forge has no HTML parser dependency, so this tokenizes tags itself and
// keeps opencode's rules for omitted elements (script, style, iframe and similar) and the 5 MiB output cap.

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

const OMITTED = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template', 'head', 'svg', 'canvas', 'select', 'button']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BLOCKS = new Set(['address', 'article', 'aside', 'details', 'dialog', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'main', 'nav', 'p', 'section', 'summary', 'table', 'thead', 'tbody', 'tfoot', 'ul', 'ol', 'body', 'html']);
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', euro: '€', pound: '£', yen: '¥', deg: '°', para: '¶', sect: '§', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
};
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</gu;

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/giu, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'iu').exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

export function convertHTMLToMarkdown(html: string): string {
  let out = '';
  let omitted = 0, pre = 0;
  const links: { href?: string; start: number }[] = [];
  const quotes: number[] = [];
  const lists: { ordered: boolean; next: number }[] = [];
  let row: { cells: number; header: boolean } | undefined, headerDone = false;
  const atLineStart = () => out === '' || out.endsWith('\n');
  const newline = () => { if (!atLineStart()) out += '\n'; };
  const block = () => { if (out === '') return; out = out.replace(/[ \t]+$/u, ''); if (!out.endsWith('\n\n')) out += out.endsWith('\n') ? '\n' : '\n\n'; };
  const append = (text: string) => { if (Buffer.byteLength(out) < MAX_MARKDOWN_BYTES) out += text; };
  for (const match of html.matchAll(TOKEN)) {
    const [token, cdata, closing, rawName, attributes = ''] = match;
    if (token.startsWith('<!--') || (token.startsWith('<!') && cdata === undefined) || token.startsWith('<?')) continue;
    if (rawName === undefined) {
      if (omitted) continue;
      const text = decodeEntities(cdata ?? token);
      if (pre) { append(text); continue; }
      let collapsed = text.replace(/\s+/gu, ' ');
      if (atLineStart() || out.endsWith(' ')) collapsed = collapsed.replace(/^ /u, '');
      if (row) collapsed = collapsed.replace(/\|/gu, '\\|');
      append(collapsed);
      continue;
    }
    const name = rawName.toLowerCase();
    if (OMITTED.has(name)) {
      if (VOID.has(name) || attributes.trimEnd().endsWith('/')) continue;
      omitted = Math.max(0, omitted + (closing ? -1 : 1));
      continue;
    }
    if (omitted) continue;
    if (closing) {
      if (/^h[1-6]$/u.test(name) || name === 'p' || BLOCKS.has(name)) {
        if (name === 'ul' || name === 'ol') lists.pop();
        if (name === 'table') { row = undefined; headerDone = false; }
        block();
      } else if (name === 'pre') { pre = Math.max(0, pre - 1); newline(); append('```'); block(); }
      else if (name === 'blockquote') {
        const start = quotes.pop() ?? out.length;
        const body = out.slice(start).trim();
        out = out.slice(0, start) + body.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
        block();
      } else if (name === 'a') {
        const link = links.pop();
        if (link) {
          const text = out.slice(link.start).trim();
          if (link.href && text && !/^javascript:/iu.test(link.href)) out = `${out.slice(0, link.start)}[${text}](${link.href})`;
        }
      } else if (name === 'strong' || name === 'b') append('**');
      else if (name === 'em' || name === 'i') append('*');
      else if (name === 'del' || name === 's') append('~~');
      else if (name === 'code' && !pre) append('`');
      else if (name === 'li') newline();
      else if ((name === 'td' || name === 'th') && row) { out = out.replace(/\s+$/u, ''); append(' |'); }
      else if (name === 'tr' && row) {
        if (row.header && !headerDone) { append(`\n|${' --- |'.repeat(row.cells)}`); headerDone = true; }
        row = undefined; newline();
      }
      continue;
    }
    const heading = /^h([1-6])$/u.exec(name);
    if (heading) { block(); append(`${'#'.repeat(Number(heading[1]))} `); }
    else if (name === 'p' || BLOCKS.has(name)) {
      block();
      if (name === 'ul' || name === 'ol') lists.push({ ordered: name === 'ol', next: Number(attribute(attributes, 'start')) || 1 });
    } else if (name === 'br') { append('\n'); }
    else if (name === 'hr') { block(); append('---'); block(); }
    else if (name === 'pre') { block(); append('```\n'); pre++; }
    else if (name === 'blockquote') { block(); quotes.push(out.length); }
    else if (name === 'a') links.push({ href: attribute(attributes, 'href'), start: out.length });
    else if (name === 'img') {
      const src = attribute(attributes, 'src');
      if (src && !src.startsWith('data:')) append(`![${attribute(attributes, 'alt') ?? ''}](${src})`);
    } else if (name === 'strong' || name === 'b') append('**');
    else if (name === 'em' || name === 'i') append('*');
    else if (name === 'del' || name === 's') append('~~');
    else if (name === 'code' && !pre) append('`');
    else if (name === 'li') {
      newline();
      const list = lists[lists.length - 1];
      append(`${'  '.repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${list.next++}. ` : '- '}`);
    } else if (name === 'tr') { newline(); row = { cells: 0, header: false }; append('|'); }
    else if ((name === 'td' || name === 'th') && row) { row.cells++; if (name === 'th') row.header = true; append(' '); }
  }
  return out.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

export function extractTextFromHTML(html: string): string {
  let out = '', omitted = 0;
  for (const match of html.matchAll(TOKEN)) {
    const [token, cdata, closing, rawName, attributes = ''] = match;
    if (rawName === undefined) {
      if (!omitted && !token.startsWith('<!') && !token.startsWith('<?')) out += decodeEntities(cdata ?? token);
      continue;
    }
    const name = rawName.toLowerCase();
    if (OMITTED.has(name)) {
      if (!VOID.has(name) && !attributes.trimEnd().endsWith('/')) omitted = Math.max(0, omitted + (closing ? -1 : 1));
      continue;
    }
    if (!omitted && (BLOCKS.has(name) || name === 'br' || name === 'li' || name === 'tr' || /^h[1-6]$/u.test(name))) out += '\n';
  }
  return out.replace(/[ \t\f\v\r]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}
