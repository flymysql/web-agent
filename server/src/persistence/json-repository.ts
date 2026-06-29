import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Repository<T extends { id: string }> {
  get(id: string): T | undefined;
  list(): T[];
  upsert(entity: T): T;
  delete(id: string): void;
}

export interface RepositoryOptions {
  /** Cap the number of retained records; oldest (by insertion order) are pruned. */
  maxItems?: number;
}

const DATA_DIR = resolve(process.cwd(), '.data');

/**
 * JSON-file backed repository. Loads the whole collection into memory on
 * construction and persists on every mutation using an atomic temp-file rename
 * (so a crash mid-write can never corrupt the live file). A corrupt file on load
 * is backed up rather than silently discarded. Swap for SQLite behind the same
 * interface when query/volume needs grow.
 */
export class JsonRepository<T extends { id: string }> implements Repository<T> {
  private readonly file: string;
  private readonly items = new Map<string, T>();
  private readonly maxItems?: number;

  constructor(name: string, dir: string = DATA_DIR, options: RepositoryOptions = {}) {
    this.file = join(dir, `${name}.json`);
    this.maxItems = options.maxItems;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as T[];
      for (const item of parsed) {
        if (item && typeof item.id === 'string') this.items.set(item.id, item);
      }
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      console.error(`[persistence] Failed to load ${this.file}, backing up to ${backup}:`, err);
      try {
        renameSync(this.file, backup);
      } catch {
        /* ignore backup failure */
      }
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 2));
      renameSync(tmp, this.file); // atomic on the same filesystem
    } catch (err) {
      console.error(`[persistence] Failed to persist ${this.file}:`, err);
    }
  }

  /** Drop oldest records (Map preserves insertion order) beyond maxItems. */
  private prune(): void {
    if (!this.maxItems) return;
    while (this.items.size > this.maxItems) {
      const oldest = this.items.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  list(): T[] {
    return [...this.items.values()];
  }

  upsert(entity: T): T {
    // Re-insert at the end so recently-touched records survive pruning longest.
    this.items.delete(entity.id);
    this.items.set(entity.id, entity);
    this.prune();
    this.persist();
    return entity;
  }

  delete(id: string): void {
    if (this.items.delete(id)) this.persist();
  }
}
