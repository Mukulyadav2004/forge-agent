// Ported from anomalyco/opencode packages/core/src/tool/plugin/webfetch.ts (MIT): http(s) only, no credentials in the
// URL, redirects followed manually (each target re-checked, at most 10), textual content only, a 5 MiB body cap and
// a timeout of at most 120 seconds.
import { convertHTMLToMarkdown, extractTextFromHTML, MAX_MARKDOWN_BYTES } from './htmlMarkdown';

export const WEB_FETCH_LIMITS = { max_response_bytes: MAX_MARKDOWN_BYTES, timeout_seconds_default: 30, timeout_seconds_max: 120, redirects: 10 };
export type FetchFormat = 'text' | 'markdown' | 'html';

const USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ForgeAgent/0.0.1';
const ACCEPT: Record<FetchFormat, string> = {
  markdown: 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1',
  text: 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1',
  html: 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1',
};
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function assertHttpUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must use http:// or https://');
  if (url.username || url.password) throw new Error('URL must not include credentials');
}

function isTextual(mime: string): boolean {
  return mime === '' || mime.startsWith('text/') || /^application\/(?:json|ld\+json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript|ecmascript|x-javascript|x-sh|x-yaml|yaml|toml|graphql|sql|x-www-form-urlencoded)$/u.test(mime) || mime.endsWith('+json') || mime.endsWith('+xml') || mime === 'image/svg+xml';
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`Response too large (exceeds ${limit} byte limit)`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); throw new Error(`Response too large (exceeds ${limit} byte limit)`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface FetchResult { url: string; status: number; contentType: string; output: string; bytes: number }

export async function webFetch(options: { url: string; format: FetchFormat; timeoutSeconds: number; signal: AbortSignal }): Promise<FetchResult> {
  const start = new URL(options.url.split('#')[0] ?? options.url);
  assertHttpUrl(start);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(options.timeoutSeconds, WEB_FETCH_LIMITS.timeout_seconds_max) * 1000)]);
  let url = start.href;
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT[options.format], 'Accept-Language': 'en-US,en;q=0.9' } });
      const location = response.headers.get('location');
      if (REDIRECTS.has(response.status) && location) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects >= WEB_FETCH_LIMITS.redirects) throw new Error(`Too many redirects (more than ${WEB_FETCH_LIMITS.redirects})`);
        const target = new URL(location, url);
        assertHttpUrl(target);
        target.hash = '';
        url = target.href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`Request failed with status code ${response.status}`); }
      const contentType = response.headers.get('content-type') ?? '';
      const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (mime.startsWith('image/') && mime !== 'image/svg+xml') throw new Error(`Unsupported fetched image content type: ${mime}`);
      if (!isTextual(mime)) throw new Error(`Unsupported fetched file content type: ${mime}`);
      const body = await boundedBody(response, WEB_FETCH_LIMITS.max_response_bytes);
      const content = new TextDecoder().decode(body);
      const html = contentType.includes('text/html') || contentType.includes('application/xhtml');
      const output = !html || options.format === 'html' ? content : options.format === 'markdown' ? convertHTMLToMarkdown(content) : extractTextFromHTML(content);
      return { url, status: response.status, contentType, output, bytes: body.byteLength };
    }
  } catch (error) {
    if (signal.aborted && !options.signal.aborted) throw new Error('Request timed out', { cause: error });
    throw error;
  }
}
