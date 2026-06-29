import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Repository<T extends { id: string }> {
  get(id: string): T | undefined;
  list(): T[];
  upsert(entity: T): T;
  delete(id: string): void;
}

const DATA_DIR = resolve(process.cwd(), '.data');

/**
 * Simple JSON-file backed repository. Loads the whole collection into memory on
 * construction and persists synchronously on every mutation. Adequate for the
 * current scale; swap this implementation for SQLite behind the same interface
 * when query/volume needs grow.
 */
export class JsonRepository<T extends { id: string }> implements Repository<T> {
  private readonly file: string;
  private readonly items = new Map<string, T>();

  constructor(name: string, dir: string = DATA_DIR) {
    this.file = join(dir, `${name}.json`);
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
      console.error(`[persistence] Failed to load ${this.file}:`, err);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify([...this.items.values()], null, 2));
    } catch (err) {
      console.error(`[persistence] Failed to persist ${this.file}:`, err);
    }
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  list(): T[] {
    return [...this.items.values()];
  }

  upsert(entity: T): T {
    this.items.set(entity.id, entity);
    this.persist();
    return entity;
  }

  delete(id: string): void {
    if (this.items.delete(id)) this.persist();
  }
}
