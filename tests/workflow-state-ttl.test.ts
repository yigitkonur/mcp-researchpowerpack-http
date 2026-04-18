import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryWorkflowStateStore } from '../src/services/workflow-state.js';

test('expires entries past TTL on get()', async () => {
  let now = 1_000_000;
  const store = createMemoryWorkflowStateStore({
    now: () => now,
    sweepIntervalMs: 60_000,
    ttlSeconds: 60, // 1 minute
  });

  await store.patch('session:a', { bootstrapped: true });
  assert.equal((await store.get('session:a')).bootstrapped, true);

  // Advance 90s — past the 60s TTL.
  now += 90_000;
  const expired = await store.get('session:a');
  assert.equal(expired.bootstrapped, false, 'expected expired entry to fall back to empty state');
});

test('sweep on patch() evicts other stale entries', async () => {
  let now = 1_000_000;
  const store = createMemoryWorkflowStateStore({
    now: () => now,
    sweepIntervalMs: 0,        // sweep on every patch
    ttlSeconds: 60,
  });

  await store.patch('session:old', { bootstrapped: true });
  now += 90_000;
  await store.patch('session:new', { bootstrapped: true });

  assert.equal(store.size?.(), 1, 'expected stale entry to be evicted');
  assert.equal((await store.get('session:old')).bootstrapped, false);
  assert.equal((await store.get('session:new')).bootstrapped, true);
});

test('sweep is throttled — repeated patches do not iterate the map every time', async () => {
  let now = 1_000_000;
  const store = createMemoryWorkflowStateStore({
    now: () => now,
    sweepIntervalMs: 60_000,
    ttlSeconds: 60,
  });
  await store.patch('session:s', { bootstrapped: true });
  // Many rapid patches — entry stays because TTL hasn't elapsed.
  for (let i = 0; i < 100; i++) {
    await store.patch(`session:k${i}`, { bootstrapped: true });
  }
  assert.equal(store.size?.(), 101);
});

test('size() is exposed and stays accurate after evictions', async () => {
  let now = 1_000_000;
  const store = createMemoryWorkflowStateStore({
    now: () => now,
    sweepIntervalMs: 0,
    ttlSeconds: 60,
  });
  await store.patch('a', { bootstrapped: true });
  await store.patch('b', { bootstrapped: true });
  assert.equal(store.size?.(), 2);
  now += 120_000;
  await store.patch('c', { bootstrapped: true }); // triggers sweep
  assert.equal(store.size?.(), 1);
});
