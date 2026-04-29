/**
 * Query relaxation for web-search.
 *
 * Two-phase rewriter that addresses systematic Google query failures observed
 * in the Serper log:
 *  - 3+ back-to-back quoted phrases get implicit-AND'd by Google → no page
 *    contains all rare tokens → 0 results.
 *  - Quoted phrases with operator chars (parens, colons, brackets) — Google
 *    strips them inside quotes, so the quotes only impose a pointless AND.
 *  - Quoted paths/URLs (`/`, `~/`, leading `@`, 3+ dots) — same reason.
 *  - Tiny `site:` corpus that returns 0 — drop site filter on retry.
 *  - Verbatim long phrases that don't appear word-for-word — strip quotes on retry.
 *
 * Phase A (`normalizeQueryForDispatch`) is always-on, deterministic, lossless.
 * Phase B (`relaxQueryForRetry`) is aggressive; only invoke when Phase A's
 * dispatched form returned zero results.
 */

const QUOTED_PHRASE_RE = /"([^"]*)"/g;
const HAS_BOOLEAN_GROUPING = /\b(?:OR|AND)\b|[()]/;
const OPERATOR_CHAR_IN_PHRASE = /[():[\]]/;
const OPERATOR_CHAR_GLOBAL = /[():[\]]/g;
const PATH_LIKE_IN_PHRASE = /\/|~\/|^@|\.{3,}/;
const URI_SCHEME_IN_PHRASE = /^[a-z][a-z0-9+.-]*:/i;
const HAS_SITE_OPERATOR = /\bsite:\S+/i;
const SITE_OPERATOR_GLOBAL = /\bsite:\S+/gi;

export interface RewriteResult {
  rewritten: string;
  changed: boolean;
  rules: string[];
}

interface PhraseSeg { type: 'phrase'; text: string; quoted: boolean }
interface RawSeg { type: 'raw'; text: string }
type Seg = PhraseSeg | RawSeg;

function renderSeg(seg: Seg): string {
  return seg.type === 'raw' ? seg.text : seg.quoted ? `"${seg.text}"` : seg.text;
}

function tokenize(query: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of query.matchAll(QUOTED_PHRASE_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (start > last) segs.push({ type: 'raw', text: query.slice(last, start) });
    segs.push({ type: 'phrase', text: m[1] ?? '', quoted: true });
    last = end;
  }
  if (last < query.length) segs.push({ type: 'raw', text: query.slice(last) });
  return segs;
}

function rebuild(segs: Seg[]): string {
  return segs
    .map(renderSeg)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function onlyWhitespaceBetween(segs: Seg[], fromIndex: number, toIndex: number): boolean {
  for (let i = fromIndex + 1; i < toIndex; i += 1) {
    const seg = segs[i];
    if (seg === undefined) continue;
    if (seg.type !== 'raw' || seg.text.trim() !== '') {
      return false;
    }
  }
  return true;
}

function buildAnchoredOrGroup(segs: Seg[], quotedIndices: number[]): string | null {
  const groupStart = quotedIndices[1];
  const groupEnd = quotedIndices[quotedIndices.length - 1];
  if (groupStart === undefined || groupEnd === undefined) {
    return null;
  }

  for (let i = 2; i < quotedIndices.length; i += 1) {
    const previous = quotedIndices[i - 1];
    const current = quotedIndices[i];
    if (
      previous === undefined
      || current === undefined
      || !onlyWhitespaceBetween(segs, previous, current)
    ) {
      return null;
    }
  }

  const groupIndices = new Set(quotedIndices.slice(1));
  const parts: string[] = [];
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg === undefined) continue;

    if (seg.type === 'raw') {
      if (i > groupStart && i < groupEnd) {
        continue;
      }
      parts.push(seg.text);
      continue;
    }

    if (groupIndices.has(i)) {
      parts.push(i === groupStart ? ' (' : ' OR ');
      parts.push(renderSeg(seg));
      if (i === groupEnd) {
        parts.push(')');
      }
      continue;
    }

    parts.push(renderSeg(seg));
  }

  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Phase A — pre-dispatch normalizer. Runs on every query before it leaves the
 * server. Three rules apply in order; each only fires when the original query
 * was statistically going to mis-handle in Google anyway.
 *
 * Rule A1: phrase contains `(`, `)`, `:`, `[`, `]` → drop quotes; replace those
 *          chars with space (Google strips them inside quotes anyway).
 * Rule A2: phrase contains a URI scheme, `/`, `~/`, leading `@`, or 3+ dots
 *          → drop quotes only (Google tokenizes path separators in or out of quotes).
 * Rule A3: ≥3 still-quoted phrases AND no existing `OR`/`AND`/parens → keep
 *          first phrase as anchor; group consecutive subsequent phrases with
 *          ` OR `. Bare words and `site:`/`filetype:` operators are preserved
 *          verbatim.
 */
export function normalizeQueryForDispatch(query: string): RewriteResult {
  const original = query.trim().replace(/\s+/g, ' ');
  if (!original) {
    return { rewritten: original, changed: false, rules: [] };
  }
  const segs = tokenize(query);
  const rules: string[] = [];

  // A1 — operator chars inside quotes are pointless AND constraints.
  for (const s of segs) {
    if (
      s.type === 'phrase'
      && s.quoted
      && OPERATOR_CHAR_IN_PHRASE.test(s.text)
      && !URI_SCHEME_IN_PHRASE.test(s.text)
    ) {
      s.quoted = false;
      s.text = s.text.replace(OPERATOR_CHAR_GLOBAL, ' ');
      if (!rules.includes('A1')) rules.push('A1');
    }
  }

  // A2 — path/URL inside quotes; quoting doesn't help recall.
  for (const s of segs) {
    if (
      s.type === 'phrase'
      && s.quoted
      && (URI_SCHEME_IN_PHRASE.test(s.text) || PATH_LIKE_IN_PHRASE.test(s.text))
    ) {
      s.quoted = false;
      if (!rules.includes('A2')) rules.push('A2');
    }
  }

  // A3 — phrase-AND collapse. Trigger requires ≥3 phrases that survive A1+A2,
  // and no existing boolean grouping in the raw (non-quoted) part of the query.
  const stillQuotedIndices: number[] = [];
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg?.type === 'phrase' && seg.quoted) {
      stillQuotedIndices.push(i);
    }
  }
  const rawJoined = segs
    .filter((s): s is RawSeg => s.type === 'raw')
    .map((s) => s.text)
    .join(' ');

  if (stillQuotedIndices.length >= 3 && !HAS_BOOLEAN_GROUPING.test(rawJoined)) {
    const grouped = buildAnchoredOrGroup(segs, stillQuotedIndices);
    if (grouped !== null) {
      rules.push('A3');
      return { rewritten: grouped, changed: grouped !== original, rules };
    }
  }

  const rewritten = rebuild(segs);
  return { rewritten, changed: rewritten !== original, rules };
}

/**
 * Phase B — on-empty retry. Only invoked for queries whose Phase-A dispatched
 * form returned zero results from Serper. Strips ALL remaining quotes and the
 * `site:` operator (if present). Caller should skip the retry when the
 * relaxed form equals the dispatched form.
 *
 * Rule B1: strip every `"` (turns each phrase into a bag of words; Google
 *          ranks by token co-occurrence instead of forcing verbatim match).
 * Rule B2: drop `site:operator` (broadens to open web; catches "tiny corpus"
 *          and "site path doesn't exist" cases at once).
 */
export function relaxQueryForRetry(
  query: string,
  options: { dropSite?: boolean } = {},
): RewriteResult {
  const original = query.trim().replace(/\s+/g, ' ');
  if (!original) {
    return { rewritten: original, changed: false, rules: [] };
  }
  const dropSite = options.dropSite ?? true;
  const rules: string[] = [];
  let result = query;

  if (result.includes('"')) {
    result = result.replace(/"/g, '');
    rules.push('B1');
  }

  if (dropSite && HAS_SITE_OPERATOR.test(result)) {
    result = result.replace(SITE_OPERATOR_GLOBAL, ' ');
    rules.push('B2');
  }

  result = result.replace(/\s+/g, ' ').trim();
  return { rewritten: result, changed: result !== original, rules };
}
