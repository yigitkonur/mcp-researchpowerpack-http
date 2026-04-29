import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _resetLLMHealthForTests,
  createLLMProcessor,
  getLLMHealth,
  markLLMFailure,
  markLLMSuccess,
} from '../src/services/llm-processor.js';
import {
  getCapabilities,
  getLLMConfigStatus,
} from '../src/config/index.js';

const LLM_ENV_KEYS = [
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_FALLBACK_MODEL',
] as const;

function withLlmEnv<T>(
  env: Partial<Record<(typeof LLM_ENV_KEYS)[number], string>>,
  fn: () => T,
): T {
  const saved: Partial<Record<(typeof LLM_ENV_KEYS)[number], string>> = {};
  for (const key of LLM_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const key of LLM_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

test('LLM_API_KEY-only config is reported disabled without throwing', () => {
  withLlmEnv({ LLM_API_KEY: 'test-key' }, () => {
    assert.doesNotThrow(() => getCapabilities());

    const status = getLLMConfigStatus();
    assert.equal(status.configured, false);
    assert.equal(status.apiKeyPresent, true);
    assert.equal(status.baseUrlPresent, false);
    assert.equal(status.modelPresent, false);
    assert.deepEqual(status.missingVars, ['LLM_BASE_URL', 'LLM_MODEL']);
    assert.match(status.error ?? '', /LLM_BASE_URL, LLM_MODEL/);

    const capabilities = getCapabilities();
    assert.equal(capabilities.llmExtraction, false);

    const h = getLLMHealth();
    assert.equal(h.plannerConfigured, false);
    assert.equal(h.extractorConfigured, false);
    assert.equal(createLLMProcessor(), null);
  });
});

test('complete LLM config is reported enabled', () => {
  withLlmEnv({
    LLM_API_KEY: 'test-key',
    LLM_BASE_URL: 'https://llm.example.test/v1',
    LLM_MODEL: 'test-model',
  }, () => {
    assert.doesNotThrow(() => getCapabilities());

    const status = getLLMConfigStatus();
    assert.equal(status.configured, true);
    assert.equal(status.apiKeyPresent, true);
    assert.equal(status.baseUrlPresent, true);
    assert.equal(status.modelPresent, true);
    assert.deepEqual(status.missingVars, []);
    assert.equal(status.error, null);

    const capabilities = getCapabilities();
    assert.equal(capabilities.llmExtraction, true);

    const h = getLLMHealth();
    assert.equal(h.plannerConfigured, true);
    assert.equal(h.extractorConfigured, true);
  });
});

test('consecutive-failure counters start at 0', () => {
  _resetLLMHealthForTests();
  const h = getLLMHealth();
  assert.equal(h.consecutivePlannerFailures, 0);
  assert.equal(h.consecutiveExtractorFailures, 0);
});

test('markLLMFailure increments the matching consecutive counter', () => {
  _resetLLMHealthForTests();
  markLLMFailure('planner', 'first blip');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 1);
  markLLMFailure('planner', 'second blip');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 2);
  markLLMFailure('planner', 'third blip');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 3);
  // Extractor counter is untouched.
  assert.equal(getLLMHealth().consecutiveExtractorFailures, 0);
});

test('markLLMSuccess resets the matching consecutive counter to 0', () => {
  _resetLLMHealthForTests();
  markLLMFailure('planner', 'a');
  markLLMFailure('planner', 'b');
  markLLMFailure('planner', 'c');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 3);
  markLLMSuccess('planner');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 0);
  // A subsequent failure starts the count over at 1, not from the old value.
  markLLMFailure('planner', 'd');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 1);
});

test('planner and extractor counters are independent', () => {
  _resetLLMHealthForTests();
  markLLMFailure('planner', 'p1');
  markLLMFailure('planner', 'p2');
  markLLMFailure('extractor', 'e1');
  const h = getLLMHealth();
  assert.equal(h.consecutivePlannerFailures, 2);
  assert.equal(h.consecutiveExtractorFailures, 1);
  // Succeeding one does not affect the other.
  markLLMSuccess('extractor');
  const h2 = getLLMHealth();
  assert.equal(h2.consecutivePlannerFailures, 2);
  assert.equal(h2.consecutiveExtractorFailures, 0);
});

test('_resetLLMHealthForTests zeroes the counters', () => {
  markLLMFailure('planner', 'x');
  markLLMFailure('extractor', 'y');
  _resetLLMHealthForTests();
  const h = getLLMHealth();
  assert.equal(h.consecutivePlannerFailures, 0);
  assert.equal(h.consecutiveExtractorFailures, 0);
});
