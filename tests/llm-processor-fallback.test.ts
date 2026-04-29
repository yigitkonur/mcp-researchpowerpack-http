import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import type { OpenAITextGenerator } from '../src/services/llm-processor.js';

const PRIMARY_MODEL = 'test-primary-model';
const FALLBACK_MODEL = 'test-fallback-model';

process.env.LLM_API_KEY = 'test-key';
process.env.LLM_BASE_URL = 'https://llm.example.test/v1';
process.env.LLM_MODEL = PRIMARY_MODEL;
process.env.LLM_FALLBACK_MODEL = FALLBACK_MODEL;

const {
  _resetLLMHealthForTests,
  processContentWithLLM,
} = await import('../src/services/llm-processor.js');

type QueuedOutcome =
  | { readonly kind: 'content'; readonly content: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly error: unknown };

class ProviderError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };

  constructor(
    message: string,
    options: {
      readonly status?: number;
      readonly code?: string;
      readonly nestedCode?: string;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.status = options.status;
    this.code = options.code;
    if (options.nestedCode) {
      this.error = {
        code: options.nestedCode,
        message,
      };
    }
  }
}

function content(value: string): QueuedOutcome {
  return { kind: 'content', content: value };
}

function empty(): QueuedOutcome {
  return { kind: 'empty' };
}

function providerError(error: unknown): QueuedOutcome {
  return { kind: 'error', error };
}

function createMockProcessor(outcomes: readonly QueuedOutcome[]): {
  readonly processor: OpenAITextGenerator;
  readonly models: string[];
} {
  const queue = [...outcomes];
  const models: string[] = [];

  return {
    models,
    processor: {
      chat: {
        completions: {
          create: async (body) => {
            models.push(body.model);
            const next = queue.shift();
            if (!next) {
              throw new Error(`Unexpected LLM call for model ${body.model}`);
            }

            if (next.kind === 'error') {
              throw next.error;
            }

            return {
              choices: [
                {
                  message: {
                    content: next.kind === 'empty' ? '' : next.content,
                  },
                },
              ],
            };
          },
        },
      },
    },
  };
}

beforeEach(() => {
  _resetLLMHealthForTests();
});

test('processContentWithLLM retries a transient primary provider failure before using fallback', async () => {
  const { processor, models } = createMockProcessor([
    providerError(new ProviderError('temporary provider outage', { status: 503, code: 'server_error' })),
    content('primary retry succeeded'),
  ]);

  const result = await processContentWithLLM(
    'raw page content',
    { enabled: true, extract: 'facts' },
    processor,
  );

  assert.equal(result.processed, true);
  assert.equal(result.content, 'primary retry succeeded');
  assert.deepEqual(models, [PRIMARY_MODEL, PRIMARY_MODEL]);
});

test('processContentWithLLM routes primary context-window errors directly to fallback', async () => {
  const { processor, models } = createMockProcessor([
    providerError(new ProviderError('maximum context length exceeded', { status: 400, code: 'context_length_exceeded' })),
    content('fallback handled oversized prompt'),
  ]);

  const result = await processContentWithLLM(
    'raw page content',
    { enabled: true, extract: 'facts' },
    processor,
  );

  assert.equal(result.processed, true);
  assert.equal(result.content, 'fallback handled oversized prompt');
  assert.deepEqual(models, [PRIMARY_MODEL, FALLBACK_MODEL]);
});

test('processContentWithLLM retries fallback provider failures until fallback succeeds', async () => {
  const { processor, models } = createMockProcessor([
    providerError(new ProviderError('prompt is too long', { status: 400, nestedCode: 'context_length_exceeded' })),
    providerError(new ProviderError('fallback timeout', { status: 504, code: 'timeout' })),
    providerError(new ProviderError('fallback overloaded', { status: 503, code: 'server_error' })),
    content('fallback retry succeeded'),
  ]);

  const result = await processContentWithLLM(
    'raw page content',
    { enabled: true, extract: 'facts' },
    processor,
  );

  assert.equal(result.processed, true);
  assert.equal(result.content, 'fallback retry succeeded');
  assert.deepEqual(models, [PRIMARY_MODEL, FALLBACK_MODEL, FALLBACK_MODEL, FALLBACK_MODEL]);
});

test('processContentWithLLM treats a true empty response as non-retryable empty output', async () => {
  const { processor, models } = createMockProcessor([
    empty(),
  ]);

  const result = await processContentWithLLM(
    'raw page content',
    { enabled: true, extract: 'facts' },
    processor,
  );

  assert.equal(result.processed, false);
  assert.equal(result.content, 'raw page content');
  assert.equal(result.error, 'LLM returned empty response');
  assert.equal(result.errorDetails?.retryable, false);
  assert.deepEqual(models, [PRIMARY_MODEL]);
});
