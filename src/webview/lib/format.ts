export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

/** A glob as a place name: the whole workspace reads as "codebase". */
export const where = (glob: string) => !glob || glob === '**/*' ? 'codebase' : glob;

/** Compact character or token count: 950, 4.1k, 41k. */
export const size = (count: number) => count < 1000 ? `${count}` : count < 10000 ? `${(count / 1000).toFixed(1)}k` : `${Math.round(count / 1000)}k`;

/** Token count as Cline's formatLargeNumber shows it: 1.2k, 3.4m. */
export function formatLargeNumber(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}b`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}m`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`;
  return String(count);
}

export const shortModel = (name: string) => name.slice(name.indexOf('/') + 1) || name;

export const fileName = (path: string) => path.split(/[\\/]/u).pop() || path;

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString('en-US', today
    ? { hour: 'numeric', minute: '2-digit', hour12: true }
    : { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(', ', ' ').replace(' at', ',');
}
