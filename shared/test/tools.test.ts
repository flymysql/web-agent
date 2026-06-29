import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_TOOLS,
  getToolDefinition,
  isBrowserTool,
  isBackendTool,
  assessRiskFromText,
} from '../src/index.js';

test('core + new tools are registered', () => {
  const names = ALL_TOOLS.map((t) => t.name);
  for (const expected of ['click', 'type', 'navigate', 'expect', 'wait', 'screenshot', 'cookie', 'tab']) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
});

test('tool runtime classification', () => {
  assert.equal(getToolDefinition('click')?.runtime, 'browser');
  assert.ok(isBrowserTool('navigate'));
  assert.ok(!isBrowserTool('notify'));
  assert.ok(isBackendTool('notify'));
});

test('risk assessment flags dangerous intents', () => {
  assert.equal(assessRiskFromText('please delete the account'), 'high');
  assert.equal(assessRiskFromText('read the page title'), 'low');
});
