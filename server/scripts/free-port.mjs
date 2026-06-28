#!/usr/bin/env node
// Frees the dev port by killing any stale node process listening on it.
// Only kills node/tsx processes so it never touches Chrome or other apps.
import { execSync } from 'node:child_process';

const port = process.env.PORT ?? '3847';

function pidsOnPort(p) {
  try {
    return execSync(`lsof -ti tcp:${p} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function commandOf(pid) {
  try {
    return execSync(`ps -p ${pid} -o command=`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const pids = pidsOnPort(port);
if (pids.length === 0) {
  process.exit(0);
}

for (const pid of pids) {
  const cmd = commandOf(pid);
  if (/node|tsx/.test(cmd)) {
    try {
      process.kill(Number(pid));
      console.log(`[free-port] killed stale server on :${port} (pid ${pid})`);
    } catch {
      /* already gone */
    }
  } else {
    console.warn(`[free-port] :${port} held by non-node process (pid ${pid}): ${cmd}`);
    console.warn('[free-port] not killing it. Use PORT=<other> npm run dev:server to switch.');
  }
}
