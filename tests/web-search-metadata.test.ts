import assert from 'node:assert/strict';
import test from 'node:test';

import type { MultipleSearchResponse, QuerySearchResult } from '../src/clients/search.js';
import { webSearchParamsSchema } from '../src/schemas/web-search.js';
import { NOOP_REPORTER } from '../src/tools/mcp-helpers.js';
import { handleWebSearch, type SearchExecutor } from '../src/tools/search.js';

function result(link: string, position: number) {
  return {
    title: `Result ${position}`,
    link,
    snippet: `Snippet for ${link}`,
    position,
  };
}

function search(query: string, links: readonly string[]): QuerySearchResult {
  return {
    query,
    results: links.map((link, index) => result(link, index + 1)),
    totalResults: links.length,
    related: [],
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

test('handleWebSearch metadata counts successful query records, not unique URLs', async () => {
  const calls: string[][] = [];
  const executor: SearchExecutor = async (queries): Promise<MultipleSearchResponse> => {
    calls.push([...queries]);
    return {
      searches: [
        search(queries[0] ?? '', [
          'https://example.com/a',
          'https://example.com/b',
          'https://example.com/c',
        ]),
        search(queries[1] ?? '', [
          'https://example.com/d',
          'https://example.com/e',
        ]),
        search(queries[2] ?? '', []),
      ],
      totalQueries: queries.length,
      executionTime: 9,
    };
  };
  const params = webSearchParamsSchema.parse({
    queries: ['first query', 'second query', 'plain zero result query'],
    extract: 'metadata counts',
    raw: true,
  });

  const response = await withoutConfiguredLlm(() => handleWebSearch(params, NOOP_REPORTER, executor));

  assert.equal(response.isError, false);
  assert.equal(calls.length, 1);
  if (!response.isError) {
    assert.equal(response.structuredContent?.results?.length, 5);
    assert.equal(response.structuredContent?.metadata.total_items, 3);
    assert.equal(response.structuredContent?.metadata.successful, 2);
    assert.equal(response.structuredContent?.metadata.failed, 1);
    assert.deepEqual(response.structuredContent?.metadata.low_yield_queries, ['plain zero result query']);
  }
});

test('handleWebSearch metadata uses effective query records for scope both', async () => {
  const calls: string[][] = [];
  const executor: SearchExecutor = async (queries): Promise<MultipleSearchResponse> => {
    calls.push([...queries]);
    if (calls.length > 1) {
      return {
        searches: queries.map((query) => search(query, [])),
        totalQueries: queries.length,
        executionTime: 5,
      };
    }
    return {
      searches: queries.map((query, index) => (
        index < 2
          ? search(query, [`https://example.com/${index}`])
          : search(query, [])
      )),
      totalQueries: queries.length,
      executionTime: 11,
    };
  };
  const params = webSearchParamsSchema.parse({
    queries: ['mcp oauth', 'mcp prompts'],
    extract: 'metadata counts',
    raw: true,
    scope: 'both',
  });

  const response = await withoutConfiguredLlm(() => handleWebSearch(params, NOOP_REPORTER, executor));

  assert.equal(response.isError, false);
  assert.deepEqual(calls[0], [
    'mcp oauth',
    'mcp prompts',
    'mcp oauth site:reddit.com',
    'mcp prompts site:reddit.com',
  ]);
  if (!response.isError) {
    assert.equal(response.structuredContent?.metadata.total_items, 4);
    assert.equal(response.structuredContent?.metadata.successful, 2);
    assert.equal(response.structuredContent?.metadata.failed, 2);
  }
});

test('handleWebSearch keeps reddit-side retries scoped in scope both', async () => {
  const calls: string[][] = [];
  const executor: SearchExecutor = async (queries): Promise<MultipleSearchResponse> => {
    calls.push([...queries]);
    if (calls.length === 1) {
      return {
        searches: [
          search(queries[0] ?? '', ['https://example.com/web-result']),
          search(queries[1] ?? '', []),
        ],
        totalQueries: queries.length,
        executionTime: 11,
      };
    }

    return {
      searches: [
        search(queries[0] ?? '', [
          'https://example.com/should-not-leak-from-reddit-retry',
          'https://www.reddit.com/r/typescript/',
          'https://www.reddit.com/r/typescript/comments/abc123/example/',
        ]),
      ],
      totalQueries: queries.length,
      executionTime: 5,
    };
  };
  const params = webSearchParamsSchema.parse({
    queries: ['"reddit exact"'],
    extract: 'metadata counts',
    raw: true,
    scope: 'both',
  });

  const response = await withoutConfiguredLlm(() => handleWebSearch(params, NOOP_REPORTER, executor));

  assert.equal(response.isError, false);
  assert.deepEqual(calls[0], [
    '"reddit exact"',
    '"reddit exact" site:reddit.com',
  ]);
  assert.deepEqual(calls[1], ['reddit exact site:reddit.com']);

  const body = JSON.stringify(response.structuredContent);
  assert.match(body, /https:\/\/example\.com\/web-result/);
  assert.match(body, /https:\/\/www\.reddit\.com\/r\/typescript\/comments\/abc123\/example\//);
  assert.doesNotMatch(body, /should-not-leak-from-reddit-retry/);
  assert.doesNotMatch(body, /https:\/\/www\.reddit\.com\/r\/typescript\/"/);
});
