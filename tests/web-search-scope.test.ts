import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUERY_REWRITE_PAIR_EXAMPLES,
  QUERY_REWRITE_PAIR_GUIDANCE_TEXT,
  webSearchParamsSchema,
} from '../src/schemas/web-search.js';

test('webSearchParamsSchema accepts scope: "reddit"', () => {
  const parsed = webSearchParamsSchema.parse({
    queries: ['mcp oauth'],
    extract: 'community advice',
    scope: 'reddit',
  });
  assert.equal(parsed.scope, 'reddit');
});

test('webSearchParamsSchema accepts scope: "both"', () => {
  const parsed = webSearchParamsSchema.parse({
    queries: ['mcp oauth'],
    extract: 'community advice',
    scope: 'both',
  });
  assert.equal(parsed.scope, 'both');
});

test('webSearchParamsSchema defaults scope to "web"', () => {
  const parsed = webSearchParamsSchema.parse({
    queries: ['mcp oauth'],
    extract: 'community advice',
  });
  assert.equal(parsed.scope, 'web');
});

test('webSearchParamsSchema rejects unknown scope', () => {
  assert.throws(() => webSearchParamsSchema.parse({
    queries: ['x'],
    extract: 'y',
    scope: 'twitter',
  }));
});

test('web-search schema exports generic query rewrite-pair guidance', () => {
  assert.match(QUERY_REWRITE_PAIR_GUIDANCE_TEXT, /retrieval probes, not topic labels/);
  assert.match(QUERY_REWRITE_PAIR_GUIDANCE_TEXT, /Bad: `<feature> support`/);
  assert.match(QUERY_REWRITE_PAIR_GUIDANCE_TEXT, /site:<official-docs-domain> "<feature>" "<platform-or-version>"/);
  assert.ok(QUERY_REWRITE_PAIR_EXAMPLES.some((example) => example.includes('<exact error text>')));
});

test('web-search schema guidance avoids rejected topic-specific examples', () => {
  const rejectedExactQuery = new RegExp(`"${['query', 'fan-out'].join(' ')}" "${['AI', 'Mode'].join(' ')}"`);
  const rejectedDomain = new RegExp(['developers', 'googleblog'].join('\\.'));

  assert.doesNotMatch(QUERY_REWRITE_PAIR_GUIDANCE_TEXT, rejectedExactQuery);
  assert.doesNotMatch(QUERY_REWRITE_PAIR_GUIDANCE_TEXT, rejectedDomain);
});
