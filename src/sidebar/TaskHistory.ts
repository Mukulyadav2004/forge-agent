import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityEntry, ChatMessage, FileEvidence, TaskHistoryItem, TodoItem } from '../shared/messages';

/** One saved chat. The index keeps only the list fields; the transcript is in tasks/<id>.json. */
export interface StoredTask {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  /** TrueForge session to reattach, and its last successful turn for retries. */
  sessionId?: string;
  lastGoodTurnId?: string;
  messages: ChatMessage[];
  activity: ActivityEntry[];
  inspectedFiles: FileEvidence[];
  /** The latest todo_write list, kept even after its activity entry scrolls out of the feed. */
  todos?: TodoItem[];
  contextTokens: number;
  contextWindow: number;
}

interface HistoryIndex { version: 1; tasks: TaskHistoryItem[] }

export const MAX_TASKS = 200;
const MAX_MESSAGES = 400;
const MAX_ACTIVITY = 200;
const SAVE_DELAY_MS = 750;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/u;

/** The newest todo list in an activity feed, if any. */
export function latestTodos(activity: readonly ActivityEntry[]): TodoItem[] | undefined {
  for (let index = activity.length - 1; index >= 0; index--) {
    const entry = activity[index];
    if (entry?.kind === 'todo') return entry.todos;
  }
  return undefined;
}

/** Newest first, at most `max`; returns the kept entries and the ids that fell off. */
export function pruneHistory(items: readonly TaskHistoryItem[], max = MAX_TASKS): { kept: TaskHistoryItem[]; removed: string[] } {
  const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  return { kept: sorted.slice(0, max), removed: sorted.slice(max).map(item => item.id) };
}

function isIndex(value: unknown): value is HistoryIndex {
  return typeof value === 'object' && value !== null && (value as HistoryIndex).version === 1 && Array.isArray((value as HistoryIndex).tasks);
}

/** The same bounds src/shared/messages.ts checks, so one bad entry cannot make the webview drop the whole state. */
function isListItem(value: unknown): value is TaskHistoryItem {
  const item = value as TaskHistoryItem;
  return typeof value === 'object' && value !== null && typeof item.id === 'string' && SAFE_ID.test(item.id)
    && typeof item.title === 'string' && item.title.length <= 200 && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
    && typeof item.messageCount === 'number' && Number.isSafeInteger(item.messageCount) && item.messageCount >= 0;
}

function isStoredTask(value: unknown): value is StoredTask {
  const task = value as StoredTask;
  return typeof value === 'object' && value !== null && task.version === 1 && typeof task.id === 'string' && SAFE_ID.test(task.id)
    && typeof task.title === 'string' && typeof task.updatedAt === 'number' && Array.isArray(task.messages) && Array.isArray(task.activity) && Array.isArray(task.inspectedFiles);
}

/**
 * Saved chats for one workspace, like OpenCode's per-project session store.
 * Layout: <directory>/index.json lists every task; <directory>/tasks/<id>.json holds one transcript. Writes are debounced and atomic.
 */
export class TaskHistory {
  private items: TaskHistoryItem[] = [];
  private readonly pending = new Map<string, StoredTask>();
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private loaded: Promise<void> | undefined;

  constructor(private readonly directory: string, private readonly options: { maxTasks?: number; delayMs?: number; onChange?: () => void } = {}) {}

  /** Reads the index once. A missing or damaged index starts an empty history. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      let saved: TaskHistoryItem[] = [];
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
        if (isIndex(parsed)) saved = parsed.tasks.filter(isListItem);
      } catch { saved = []; }
      // Saves made while the index was loading are newer than the file.
      this.items = pruneHistory([...this.items, ...saved.filter(item => !this.has(item.id))], this.max).kept;
      this.options.onChange?.();
    })();
    return this.loaded;
  }

  /** Newest first, for the sidebar's history list. */
  list(): TaskHistoryItem[] { return this.items.map(item => ({ ...item })); }

  has(id: string): boolean { return this.items.some(item => item.id === id); }

  async get(id: string): Promise<StoredTask | undefined> {
    if (!SAFE_ID.test(id)) return undefined;
    const queued = this.pending.get(id);
    if (queued) return structuredClone(queued);
    try {
      const parsed: unknown = JSON.parse(await readFile(this.taskFile(id), 'utf8'));
      return isStoredTask(parsed) && parsed.id === id ? parsed : undefined;
    } catch { return undefined; }
  }

  /** Queues a save. The index is updated now; files are written after a short pause. */
  save(task: StoredTask): void {
    if (!SAFE_ID.test(task.id)) return;
    const stored: StoredTask = {
      ...task,
      title: task.title.slice(0, 200),
      messages: task.messages.slice(-MAX_MESSAGES),
      activity: task.activity.slice(-MAX_ACTIVITY),
      todos: task.todos ?? latestTodos(task.activity),
    };
    this.pending.set(task.id, structuredClone(stored));
    const item: TaskHistoryItem = { id: stored.id, title: stored.title || 'Untitled task', updatedAt: stored.updatedAt, messageCount: stored.messages.length };
    const { kept, removed } = pruneHistory([item, ...this.items.filter(existing => existing.id !== task.id)], this.max);
    this.items = kept;
    for (const id of removed) { this.pending.delete(id); this.queueRemoval(id); }
    this.schedule();
    this.options.onChange?.();
  }

  async delete(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    this.pending.delete(id);
    this.items = this.items.filter(item => item.id !== id);
    this.options.onChange?.();
    this.queueRemoval(id);
    this.schedule();
    await this.flush();
  }

  /** Writes everything queued. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const tasks = [...this.pending.values()];
    this.pending.clear();
    const index: HistoryIndex = { version: 1, tasks: this.list() };
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(join(this.directory, 'tasks'), { recursive: true });
      for (const task of tasks) if (this.has(task.id)) await this.writeAtomic(this.taskFile(task.id), JSON.stringify(task));
      await this.writeAtomic(join(this.directory, 'index.json'), JSON.stringify(index));
    });
    return this.writing;
  }

  /** Last-chance write while the extension shuts down, when an async write may not finish. */
  flushSync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending.size) return;
    try {
      mkdirSync(join(this.directory, 'tasks'), { recursive: true });
      for (const task of this.pending.values()) this.writeAtomicSync(this.taskFile(task.id), JSON.stringify(task));
      this.pending.clear();
      this.writeAtomicSync(join(this.directory, 'index.json'), JSON.stringify({ version: 1, tasks: this.list() } satisfies HistoryIndex));
    } catch { /* History is best effort; the session itself is not affected. */ }
  }

  private get max(): number { return this.options.maxTasks ?? MAX_TASKS; }
  private taskFile(id: string): string { return join(this.directory, 'tasks', `${id}.json`); }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, this.options.delayMs ?? SAVE_DELAY_MS);
  }
  private queueRemoval(id: string): void {
    this.writing = this.writing.catch(() => undefined).then(() => rm(this.taskFile(id), { force: true }));
  }
  private async writeAtomic(file: string, text: string): Promise<void> {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, file);
  }
  private writeAtomicSync(file: string, text: string): void {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, file);
  }
}
