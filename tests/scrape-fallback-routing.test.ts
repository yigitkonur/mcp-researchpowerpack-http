import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleContentEntries,
  formatJinaFailure,
} from '../src/tools/scrape.js';

// ── formatJinaFailure ──────────────────────────────────────────────────────
// This formatter is the user-visible artifact of the two-layer fallback.
// When Jina alone fails, the output is a single-layer error. When Jina
// fails *after* Scrape.do already failed, the output must name both layers
// so the caller knows the URL is genuinely unreachable — not just a Jina
// hiccup.

test('formatJinaFailure: Jina-only failure (no prior scrape error)', () => {
  const line = formatJinaFailure('https://example.com/foo.pdf', 'Timeout after 30s');
  assert.match(line, /^## https:\/\/example\.com\/foo\.pdf\n/);
  assert.match(line, /Document conversion failed: Timeout after 30s/);
  assert.doesNotMatch(line, /Both scrapers failed/);
});

test('formatJinaFailure: both scrapers failed (prior scrape error present)', () => {
  const line = formatJinaFailure(
    'https://portal.myk.gov.tr/index.php?option=com_istatistik',
    'Rate limited by Jina',
    'HTTP 302 redirect loop',
  );
  assert.match(line, /Both scrapers failed/);
  assert.match(line, /Scrape\.do: HTTP 302 redirect loop/);
  assert.match(line, /Jina Reader: Rate limited by Jina/);
});

test('formatJinaFailure: treats empty scrapeError string as no-context', () => {
  // Empty string is falsy; should take the single-layer path.
  const line = formatJinaFailure('https://example.com/x.pdf', 'Invalid URL', '');
  assert.match(line, /Document conversion failed: Invalid URL/);
  assert.doesNotMatch(line, /Both scrapers failed/);
});

test('assembleContentEntries: preserves original order across successes and branch failures', () => {
  const contents = assembleContentEntries(
    [
      { url: 'https://web-success.example/page', content: 'web success', index: 2 },
      { url: 'https://document-success.example/report.pdf', content: 'document success', index: 4 },
    ],
    [
      { index: 0, content: '## not-a-url\n\n❌ Invalid URL format' },
      { index: 1, content: '## https://web-fail.example/missing\n\n❌ Failed to scrape: HTTP 404 — Page not found' },
      { index: 3, content: '## https://www.reddit.com/r/typescript/comments/abc123/example/\n\n❌ Reddit fetch failed: nope' },
      { index: 5, content: formatJinaFailure('https://document-fail.example/report.pdf', 'Target URL not reachable by Jina Reader') },
      { index: 6, content: formatJinaFailure('https://deferred-jina.example/report', 'Jina timeout', 'HTTP 502') },
    ],
  );

  const headings = contents.map((content) => content.match(/^## ([^\n]+)/)?.[1]);
  assert.deepEqual(headings, [
    'not-a-url',
    'https://web-fail.example/missing',
    'https://web-success.example/page',
    'https://www.reddit.com/r/typescript/comments/abc123/example/',
    'https://document-success.example/report.pdf',
    'https://document-fail.example/report.pdf',
    'https://deferred-jina.example/report',
  ]);
});
