import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import mermaid from 'mermaid';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text),
  },
});
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  maxTextSize: 20000,
  maxEdges: 150,
  htmlLabels: false,
  theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
  flowchart: { htmlLabels: false },
});
let diagramId = 0;

/** Renders model Markdown into `container`. Raw HTML and images are escaped, and the result is sanitised again by DOMPurify. */
export function renderMarkdown(options: { container: HTMLElement; text: string }): void {
  const html = markdown.parse(options.text, { async: false });
  options.container.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
  // Colour diff blocks line by line; each line is set as plain text, so nothing from the model is parsed as HTML.
  for (const code of Array.from(options.container.querySelectorAll('pre > code.language-diff'))) {
    const lines = (code.textContent ?? '').replace(/\n$/u, '').split('\n');
    code.replaceChildren(...lines.map(line => {
      const row = document.createElement('span');
      row.className = line.startsWith('-') ? 'diff-line diff-line-removed' : line.startsWith('+') ? 'diff-line diff-line-added' : 'diff-line';
      row.textContent = line;
      return row;
    }));
  }
  // Cline's CodeBlock copy control, added as our own element after sanitising.
  for (const pre of Array.from(options.container.querySelectorAll('pre'))) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'code-copy';
    copy.title = 'Copy code';
    copy.setAttribute('aria-label', 'Copy code');
    copy.textContent = 'Copy';
    copy.addEventListener('click', event => {
      event.stopPropagation();
      void navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? pre.textContent ?? '').then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      }, () => undefined);
    });
    pre.classList.add('has-copy');
    pre.append(copy);
  }
}

export async function renderDiagrams(container: HTMLElement): Promise<void> {
  for (const code of Array.from(container.querySelectorAll('pre > code.language-mermaid'))) {
    if (!(code instanceof HTMLElement) || code.dataset.rendering) continue;
    code.dataset.rendering = 'true';
    const source = code.textContent ?? '';
    const pre = code.parentElement;
    if (!pre || source.length > 20000) continue;
    try {
      const rendered = await mermaid.render(`forge-diagram-${++diagramId}`, source);
      if (!code.isConnected) continue;
      const diagram = document.createElement('figure');
      diagram.className = 'architecture-diagram';
      diagram.setAttribute('aria-label', 'Architecture diagram');
      diagram.innerHTML = DOMPurify.sanitize(rendered.svg, {
        USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject'],
      });
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Diagram source';
      const sourceCode = document.createElement('code');
      sourceCode.textContent = source;
      const sourcePre = document.createElement('pre');
      sourcePre.append(sourceCode);
      details.append(summary, sourcePre);
      diagram.append(details);
      pre.replaceWith(diagram);
    } catch {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'This diagram could not be rendered. Its source is shown below.';
      pre.before(note);
    }
  }
}
