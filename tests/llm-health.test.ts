import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _resetLLMHealthForTests,
  getLLMHealth,
  markLLMFailure,
  markLLMSuccess,
} from '../src/services/llm-processor.js';

test('getLLMHealth defaults: both paths report not-yet-checked', () => {
  _resetLLMHealthForTests();
  const h = getLLMHealth();
  assert.equal(h.lastPlannerOk, false);
  assert.equal(h.lastExtractorOk, false);
  assert.equal(h.lastPlannerCheckedAt, null);
  assert.equal(h.lastExtractorCheckedAt, null);
  assert.equal(h.lastPlannerError, null);
  assert.equal(h.lastExtractorError, null);
});

test('markLLMSuccess flips planner ok and stamps checkedAt', () => {
  _resetLLMHealthForTests();
  markLLMSuccess('planner');
  const h = getLLMHealth();
  assert.equal(h.lastPlannerOk, true);
  assert.equal(h.lastExtractorOk, false);
  assert.ok(h.lastPlannerCheckedAt && h.lastPlannerCheckedAt.includes('T'));
  assert.equal(h.lastPlannerError, null);
});

test('markLLMFailure flips path off and records error message', () => {
  _resetLLMHealthForTests();
  markLLMSuccess('extractor');
  markLLMFailure('extractor', new Error('Connection refused'));
  const h = getLLMHealth();
  assert.equal(h.lastExtractorOk, false);
  assert.equal(h.lastExtractorError, 'Connection refused');
  assert.ok(h.lastExtractorCheckedAt);
});

test('planner and extractor health are independent', () => {
  _resetLLMHealthForTests();
  markLLMSuccess('planner');
  markLLMFailure('extractor', 'timeout');
  const h = getLLMHealth();
  assert.equal(h.lastPlannerOk, true);
  assert.equal(h.lastExtractorOk, false);
  assert.equal(h.lastPlannerError, null);
  assert.equal(h.lastExtractorError, 'timeout');
});

test('plannerConfigured / extractorConfigured reflect env capability', () => {
  _resetLLMHealthForTests();
  const h = getLLMHealth();
  // Field is present and boolean regardless of env at test time.
  assert.equal(typeof h.plannerConfigured, 'boolean');
  assert.equal(typeof h.extractorConfigured, 'boolean');
});
