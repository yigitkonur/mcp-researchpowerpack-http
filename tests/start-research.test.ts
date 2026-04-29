import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOrientation, buildStaticScaffolding } from '../src/tools/start-research.js';

const CANONICAL_RUN_RESEARCH_INSTALL_COMMAND =
  'npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /run-research';
const RUN_RESEARCH_HINT_TEXT = 'Pair this server with the `run-research` skill';

test('static scaffolding teaches the 3-tool mental model', () => {
  const markdown = buildStaticScaffolding();

  assert.match(markdown, /## The 3 tools/);
  assert.match(markdown, /`start-research`/);
  assert.match(markdown, /`web-search`/);
  assert.match(markdown, /`scrape-links`/);
});

test('static scaffolding names the core research loop', () => {
  const markdown = buildStaticScaffolding();

  assert.match(markdown, /## The loop/);
  assert.match(markdown, /## Output discipline/);
  assert.match(markdown, /Never cite a URL from a search snippet/i);
});

test('static scaffolding teaches aggressive multi-call and parallel-callability', () => {
  const markdown = buildStaticScaffolding();

  assert.match(markdown, /aggressively/i);
  assert.match(markdown, /2[–-]4 rounds/i);
  assert.match(markdown, /Parallel-safe/i);
  assert.match(markdown, /up to 50 queries/i);
});

test('static scaffolding explains scope values for web-search', () => {
  const markdown = buildStaticScaffolding();

  assert.match(markdown, /"reddit"/);
  assert.match(markdown, /"web"/);
  assert.match(markdown, /"both"/);
  assert.match(markdown, /sentiment \/ migration/i);
});

test('static scaffolding documents scrape-links reddit auto-detection', () => {
  const markdown = buildStaticScaffolding();

  assert.match(markdown, /Auto-detects/i);
  assert.match(markdown, /reddit\.com/i);
  assert.match(markdown, /Reddit API/i);
});

test('includes the focus line when a goal is provided', () => {
  const markdown = buildStaticScaffolding('investigate MCP OAuth support');

  assert.match(markdown, /> Focus for this session: investigate MCP OAuth support/);
});

test('buildOrientation is exported as a backward-compat alias', () => {
  assert.equal(buildOrientation, buildStaticScaffolding);
});

test('scaffolding starts with the canonical run-research skill install hint', () => {
  const markdown = buildStaticScaffolding();

  assert.ok(markdown.startsWith('> '), 'expected the skill install hint block to be first');
  assert.ok(
    markdown.slice(0, 200).includes(RUN_RESEARCH_HINT_TEXT),
    'expected the first block to name the run-research skill',
  );
  assert.match(markdown, /run-research/);
  assert.match(markdown, /npx -y skills add/);
  assert.match(markdown, /https:\/\/github\.com\/yigitkonur\/skills-by-yigitkonur --skill \/run-research/);
  assert.ok(markdown.includes(CANONICAL_RUN_RESEARCH_INSTALL_COMMAND));
});
