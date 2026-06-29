import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/persistence/json-repository.js';

test('upsert/get/delete persists across reloads (atomic)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aba-repo-'));
  const repo = new JsonRepository<{ id: string; v: number }>('t', dir);
  repo.upsert({ id: 'a', v: 1 });
  assert.equal(repo.get('a')?.v, 1);

  const reloaded = new JsonRepository<{ id: string; v: number }>('t', dir);
  assert.equal(reloaded.get('a')?.v, 1);

  reloaded.delete('a');
  assert.equal(reloaded.get('a'), undefined);
  const reloaded2 = new JsonRepository<{ id: string; v: number }>('t', dir);
  assert.equal(reloaded2.get('a'), undefined);
});

test('maxItems prunes oldest records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aba-repo-'));
  const repo = new JsonRepository<{ id: string }>('t', dir, { maxItems: 2 });
  repo.upsert({ id: '1' });
  repo.upsert({ id: '2' });
  repo.upsert({ id: '3' });
  assert.equal(repo.list().length, 2);
  assert.equal(repo.get('1'), undefined);
  assert.ok(repo.get('3'));
});
