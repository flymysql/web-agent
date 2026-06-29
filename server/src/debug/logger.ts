import { v4 as uuidv4 } from 'uuid';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export type LogSource = 'server' | 'http' | 'llm' | 'tool' | 'task' | 'ws' | 'client';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DebugLogEntry {
  id: string;
  ts: number;
  source: LogSource;
  level: LogLevel;
  category: string;
  message: string;
  taskId?: string;
  data?: unknown;
}

const LOG_DIR = resolve(process.cwd(), '.data', 'logs');
const RING_MAX = 5000;
const RETAIN_DAYS = 7;
const MAX_STR = 4000;

const ring: DebugLogEntry[] = [];
let prunedToday = '';

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function fileForToday(): string {
  return join(LOG_DIR, `debug-${todayStr()}.jsonl`);
}

/** Deep-truncate large string fields so logs stay readable and bounded. */
function trunc(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STR ? `${value.slice(0, MAX_STR)}…<${value.length} chars>` : value;
  }
  if (value == null || typeof value !== 'object') return value;
  if (depth > 4) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => trunc(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = trunc(v, depth + 1);
  }
  return out;
}

function pruneOldFiles(): void {
  const today = todayStr();
  if (prunedToday === today) return;
  prunedToday = today;
  try {
    const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
    for (const f of readdirSync(LOG_DIR)) {
      const m = /^debug-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      if (new Date(m[1]).getTime() < cutoff) rmSync(join(LOG_DIR, f), { force: true });
    }
  } catch {
    /* dir may not exist yet */
  }
}

export function debugLog(input: {
  source: LogSource;
  level?: LogLevel;
  category: string;
  message: string;
  taskId?: string;
  data?: unknown;
}): void {
  const entry: DebugLogEntry = {
    id: uuidv4(),
    ts: Date.now(),
    source: input.source,
    level: input.level ?? 'info',
    category: input.category,
    message: input.message,
    taskId: input.taskId,
    data: input.data === undefined ? undefined : trunc(input.data),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    pruneOldFiles();
    appendFileSync(fileForToday(), JSON.stringify(entry) + '\n');
  } catch {
    /* never let logging crash the app */
  }

  if (entry.level === 'error') {
    console.error(`[${entry.source}] ${entry.category}: ${entry.message}`);
  }
}

export interface LogQuery {
  limit?: number;
  source?: LogSource;
  level?: LogLevel;
  taskId?: string;
  since?: number;
}

export function getDebugLogs(q: LogQuery = {}): DebugLogEntry[] {
  let items = ring;
  if (q.source) items = items.filter((e) => e.source === q.source);
  if (q.level) items = items.filter((e) => e.level === q.level);
  if (q.taskId) items = items.filter((e) => e.taskId === q.taskId);
  if (q.since) items = items.filter((e) => e.ts >= q.since!);
  const limit = q.limit ?? 500;
  return items.slice(-limit);
}

export function clearDebugLogs(): void {
  ring.length = 0;
}

/** Ingest a batch of logs produced in the browser (extension). */
export function ingestClientLogs(entries: Array<Partial<DebugLogEntry>>): number {
  let n = 0;
  for (const e of entries) {
    if (!e || typeof e.message !== 'string') continue;
    debugLog({
      source: 'client',
      level: (e.level as LogLevel) ?? 'info',
      category: e.category ?? 'client',
      message: e.message,
      taskId: e.taskId,
      data: { ...(typeof e.data === 'object' && e.data ? e.data : { value: e.data }), clientTs: e.ts },
    });
    n++;
  }
  return n;
}

/** Install process-level handlers so crashes/rejections are captured. */
export function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    debugLog({
      source: 'server',
      level: 'error',
      category: 'uncaughtException',
      message: err instanceof Error ? err.message : String(err),
      data: { stack: err instanceof Error ? err.stack : undefined },
    });
  });
  process.on('unhandledRejection', (reason) => {
    debugLog({
      source: 'server',
      level: 'error',
      category: 'unhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason),
      data: { stack: reason instanceof Error ? reason.stack : undefined },
    });
  });
}
