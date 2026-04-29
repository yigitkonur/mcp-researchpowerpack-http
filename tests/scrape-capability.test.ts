import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { MCPServer } from 'mcp-use/server';

import {
  handleScrapeLinks,
  registerScrapeLinksTool,
} from '../src/tools/scrape.js';
import type { ScrapeLinksParams } from '../src/schemas/scrape-links.js';

const SCRUBBED_ENV_KEYS = [
  'SCRAPEDO_API_KEY',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_FALLBACK_MODEL',
] as const;

for (const key of SCRUBBED_ENV_KEYS) {
  delete process.env[key];
}

type FetchArgs = Parameters<typeof fetch>;

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

interface FakeResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function installFakeFetch(t: TestContext, responses: FakeResponse[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let i = 0;
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    calls.push({ url: String(input), init });
    const response = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = original;
  });

  return calls;
}

function assertSubstringsInOrder(haystack: string, needles: string[]): void {
  let cursor = 0;
  for (const needle of needles) {
    const foundAt = haystack.indexOf(needle, cursor);
    assert.notEqual(foundAt, -1, `Expected "${needle}" after offset ${cursor}`);
    cursor = foundAt + needle.length;
  }
}

interface CapturedToolContext {
  log(level: string, message: string, loggerName?: string): Promise<void>;
  reportProgress?(loaded: number, total?: number, message?: string): Promise<void>;
}

type CapturedToolHandler = (
  args: ScrapeLinksParams,
  ctx: CapturedToolContext,
) => Promise<unknown>;

function captureRegisteredScrapeLinksHandler(): CapturedToolHandler {
  let captured: CapturedToolHandler | undefined;
  const server = {
    tool(_definition: unknown, callback?: unknown) {
      if (typeof callback !== 'function') {
        throw new Error('Expected scrape-links registration to provide a callback');
      }
      captured = (args, ctx) => Promise.resolve(callback(args, ctx));
      return server;
    },
  };

  registerScrapeLinksTool(server as unknown as MCPServer);

  if (!captured) {
    throw new Error('scrape-links handler was not registered');
  }

  return captured;
}

const noopContext: CapturedToolContext = {
  async log() {},
  async reportProgress() {},
};

test('handleScrapeLinks: web-only URLs still require SCRAPEDO_API_KEY', async () => {
  const result = await handleScrapeLinks({
    urls: ['https://example.com/page'],
    extract: 'main content',
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /SCRAPEDO_API_KEY/);
  assert.doesNotMatch(result.content, /Reddit API is not configured/);
});

test('handleScrapeLinks: document-only URLs can use Jina without SCRAPEDO_API_KEY', async (t) => {
  const calls = installFakeFetch(t, [
    {
      status: 200,
      body: '# Converted PDF\n\nThis came from the mocked Jina Reader branch.',
    },
  ]);

  const result = await handleScrapeLinks({
    urls: ['https://example.com/report.pdf'],
  });

  assert.equal(result.isError, false);
  assert.match(result.content, /Converted PDF/);
  assert.doesNotMatch(result.content, /SCRAPEDO_API_KEY/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://r.jina.ai/https://example.com/report.pdf');
  assert.equal(result.structuredContent?.metadata.successful, 1);
  assert.equal(result.structuredContent?.metadata.total_credits, 0);
});

test('handleScrapeLinks: mixed invalid, document, and reddit results render in input order', async (t) => {
  installFakeFetch(t, [
    {
      status: 200,
      body: '# Converted OK\n\nThis document should stay before the Reddit failure.',
    },
    {
      status: 404,
      body: 'not found',
    },
  ]);

  const result = await handleScrapeLinks({
    urls: [
      'not-a-url',
      'https://example.com/ok.pdf',
      'https://www.reddit.com/r/typescript/comments/abc123/example/',
      'https://example.com/broken.pdf',
    ],
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.metadata.successful, 1);
  assert.equal(result.structuredContent?.metadata.failed, 3);
  assertSubstringsInOrder(result.content, [
    '## not-a-url\n\n❌ Invalid URL format',
    '## https://example.com/ok.pdf\n\n# Converted OK',
    '## https://www.reddit.com/r/typescript/comments/abc123/example/',
    '## https://example.com/broken.pdf\n\n❌ Document conversion failed: Target URL not reachable by Jina Reader',
  ]);
});

test('registered scrape-links handler: reddit-only URLs bypass the Scrape.do gate', async () => {
  const handler = captureRegisteredScrapeLinksHandler();
  const response = await handler(
    {
      urls: ['https://www.reddit.com/r/typescript/comments/abc123/example/'],
    },
    noopContext,
  );
  const responseText = JSON.stringify(response);

  assert.match(responseText, /Reddit API is not configured/);
  assert.doesNotMatch(responseText, /SCRAPEDO_API_KEY/);
});
