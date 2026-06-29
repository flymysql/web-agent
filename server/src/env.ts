// Loads environment variables from the nearest .env at startup.
// Imported first in index.ts so process.env (LLM_API_KEY / OPENAI_API_KEY, etc.)
// is populated before any other module reads it.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type ProcWithLoad = NodeJS.Process & { loadEnvFile?: (path?: string) => void };

function loadEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'server', '.env'),
  ];
  const proc = process as ProcWithLoad;

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      if (typeof proc.loadEnvFile === 'function') {
        proc.loadEnvFile(path);
        console.log(`[env] loaded ${path}`);
      } else {
        manualLoad(path);
      }
      return;
    } catch (err) {
      console.warn(`[env] failed to load ${path}:`, err instanceof Error ? err.message : err);
    }
  }
}

// Fallback parser for Node versions without process.loadEnvFile
function manualLoad(path: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const content = fs.readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  console.log(`[env] loaded ${path} (manual)`);
}

loadEnv();
