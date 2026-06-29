import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('debug logger: ring buffer, filtering, and client ingest', async () => {
  const prev = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), 'aba-log-')));
  try {
    const { debugLog, getDebugLogs, clearDebugLogs, ingestClientLogs } = await import(
      '../src/debug/logger.js'
    );
    clearDebugLogs();

    debugLog({ source: 'tool', category: 'click', message: 'clicked' });
    debugLog({ source: 'llm', level: 'error', category: 'agent.error', message: 'boom' });
    debugLog({ source: 'task', category: 'flow', message: 'step', taskId: 't1' });

    assert.equal(getDebugLogs().length, 3);
    assert.equal(getDebugLogs({ level: 'error' }).length, 1);
    assert.equal(getDebugLogs({ source: 'tool' }).length, 1);
    assert.equal(getDebugLogs({ taskId: 't1' }).length, 1);

    const n = ingestClientLogs([
      { message: 'user said hi', level: 'info', category: 'conversation', ts: Date.now() },
      { notAMessage: true } as Record<string, unknown>,
    ]);
    assert.equal(n, 1);
    assert.equal(getDebugLogs({ source: 'client' }).length, 1);
  } finally {
    process.chdir(prev);
  }
});
