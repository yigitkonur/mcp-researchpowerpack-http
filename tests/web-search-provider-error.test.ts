import assert from 'node:assert/strict';
import test from 'node:test';

import { webSearchParamsSchema } from '../src/schemas/web-search.js';
import { handleWebSearch, type SearchExecutor } from '../src/tools/search.js';
import { NOOP_REPORTER } from '../src/tools/mcp-helpers.js';
import { ErrorCode, type StructuredError } from '../src/utils/errors.js';
import type { QuerySearchResult, MultipleSearchResponse } from '../src/clients/search.js';

function emptySearch(query: string): QuerySearchResult {
  return { query, results: [], totalResults: 0, related: [] };
}

function successfulSearch(query: string): QuerySearchResult {
  return {
    query,
    results: [{
      title: 'Example result',
      link: 'https://example.com/result',
      snippet: 'Example search result.',
      position: 1,
    }],
    totalResults: 1,
    related: [],
  };
}

function providerFailure(
  queries: readonly string[],
  error: StructuredError,
): MultipleSearchResponse {
  return {
    searches: [],
    totalQueries: queries.length,
    executionTime: 12,
    error,
  };
}

async function withoutConfiguredLlm<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_MODEL: process.env.LLM_MODEL,
    LLM_FALLBACK_MODEL: process.env.LLM_FALLBACK_MODEL,
  };

  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_FALLBACK_MODEL;

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('handleWebSearch returns toolFailure for initial search provider errors', async () => {
  const error: StructuredError = {
    code: ErrorCode.SERVICE_UNAVAILABLE,
    message: 'Serper API unavailable',
    retryable: true,
    statusCode: 503,
  };
  const calls: string[][] = [];
  const executor: SearchExecutor = async (queries) => {
    calls.push([...queries]);
    return providerFailure(queries, error);
  };
  const params = webSearchParamsSchema.parse({
    queries: ['mcp search outage'],
    extract: 'provider failure behavior',
    raw: true,
  });

  const result = await handleWebSearch(params, NOOP_REPORTER, executor);

  assert.equal(result.isError, true);
  assert.equal(calls.length, 1);
  assert.match(result.content, /SERVICE_UNAVAILABLE/);
  assert.match(result.content, /initial batch/);
  assert.match(result.content, /Serper API unavailable/);
});

test('handleWebSearch preserves initial results when relaxed retry batch fails', async () => {
  const error: StructuredError = {
    code: ErrorCode.RATE_LIMITED,
    message: 'Serper retry batch was rate limited',
    retryable: true,
    statusCode: 429,
  };
  const calls: string[][] = [];
  const executor: SearchExecutor = async (queries) => {
    calls.push([...queries]);
    if (calls.length === 1) {
      return {
        searches: [
          successfulSearch(queries[0] ?? ''),
          emptySearch(queries[1] ?? ''),
        ],
        totalQueries: queries.length,
        executionTime: 10,
      };
    }
    return providerFailure(queries, error);
  };
  const params = webSearchParamsSchema.parse({
    queries: ['stable query', '"zero exact" site:empty.example'],
    extract: 'retry failure behavior',
    raw: true,
  });

  const result = await withoutConfiguredLlm(() => handleWebSearch(params, NOOP_REPORTER, executor));

  assert.equal(result.isError, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['zero exact']);
  assert.match(result.content, /1 unique URLs/);
  assert.match(result.content, /https:\/\/example\.com\/result/);

  if (!result.isError) {
    assert.equal(result.structuredContent?.content, result.content);
    assert.equal(result.structuredContent?.results?.length, 1);
    assert.equal(result.structuredContent?.metadata.successful, 1);
    assert.equal(result.structuredContent?.metadata.failed, 1);
    assert.deepEqual(result.structuredContent?.metadata.low_yield_queries, [
      'stable query',
      '"zero exact" site:empty.example',
    ]);
    assert.deepEqual(result.structuredContent?.metadata.retried_queries, [{
      original: '"zero exact" site:empty.example',
      retried_with: 'zero exact',
      rules: ['B1', 'B2'],
      recovered_results: 0,
    }]);
    assert.deepEqual(result.structuredContent?.metadata.retry_error, {
      phase: 'relax-retry',
      code: ErrorCode.RATE_LIMITED,
      message: 'Serper retry batch was rate limited',
      retryable: true,
      statusCode: 429,
    });
  }
});

test('handleWebSearch keeps legitimate zero-result searches as successful low-yield output', async () => {
  const calls: string[][] = [];
  const executor: SearchExecutor = async (queries) => {
    calls.push([...queries]);
    return {
      searches: queries.map((query) => emptySearch(query)),
      totalQueries: queries.length,
      executionTime: 8,
    };
  };
  const params = webSearchParamsSchema.parse({
    queries: ['plain zero result query'],
    extract: 'legitimate zero results',
    raw: true,
  });

  const result = await withoutConfiguredLlm(() => handleWebSearch(params, NOOP_REPORTER, executor));

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.match(result.content, /0 unique URLs/);
  assert.match(result.content, /Low-yield queries/);

  if (!result.isError) {
    assert.equal(result.structuredContent?.content, result.content);
    assert.equal(result.structuredContent?.metadata.successful, 0);
    assert.equal(result.structuredContent?.metadata.failed, 1);
  }
});
