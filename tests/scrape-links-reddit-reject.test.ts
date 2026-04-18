import assert from 'node:assert/strict';
import test from 'node:test';

import { handleScrapeLinks } from '../src/tools/scrape.js';

const REDDIT_URLS = [
  'https://reddit.com/r/LocalLLaMA/comments/abc123/example',
  'https://www.reddit.com/r/LocalLLaMA/',
  'https://old.reddit.com/r/foo/comments/xyz/post',
  'https://np.reddit.com/r/foo/',
  'https://new.reddit.com/r/foo/comments/aaa/',
];

for (const url of REDDIT_URLS) {
  test(`scrape-links rejects Reddit URL: ${url}`, async () => {
    const result = await handleScrapeLinks({ urls: [url], extract: 'anything' });
    assert.equal(result.isError, true);
    assert.match(result.content, /UNSUPPORTED_URL_TYPE/);
    assert.match(result.content, /get-reddit-post/);
  });
}

test('mixed batch with one Reddit URL rejects whole batch', async () => {
  const result = await handleScrapeLinks({
    urls: [
      'https://example.com/blog/post',
      'https://reddit.com/r/foo/comments/bar/baz',
    ],
    extract: 'anything',
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /reddit\.com\/r\/foo\/comments\/bar\/baz/);
  // Whole-batch rejection — no partial success.
  assert.match(result.content, /UNSUPPORTED_URL_TYPE/);
});

test('non-reddit URLs do not trigger the Reddit guard', async () => {
  // We are not exercising the actual scraper here — the test environment
  // has no SCRAPEDO_API_KEY so the call will fail downstream — but the
  // failure must NOT be UNSUPPORTED_URL_TYPE.
  const result = await handleScrapeLinks({
    urls: ['https://example.com/blog/post'],
    extract: 'anything',
  });
  assert.doesNotMatch(result.content, /UNSUPPORTED_URL_TYPE/);
});
