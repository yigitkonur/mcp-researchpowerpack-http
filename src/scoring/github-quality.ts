/**
 * GitHub Repository Quality Scoring Engine
 * Pure functions — no I/O, no side effects. Takes structured data, returns scores.
 * Implements the "Gives a Damn" composite score algorithm.
 */

// ============================================================================
// Normalization Helpers
// ============================================================================

/**
 * Log-normalize a value against a threshold to 0-1 range.
 * Prevents any single metric from dominating via logarithmic compression.
 * Borrowed from OpenSSF Criticality Score (Rob Pike's formula).
 */
function logNorm(value: number, threshold: number): number {
  if (value <= 0 || threshold <= 0) return 0;
  return Math.min(1, Math.log(1 + value) / Math.log(1 + threshold));
}

/** Clamp a value between min and max */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================================
// Individual Metric Calculators (each returns 0–1)
// ============================================================================

/**
 * Shannon entropy of weekly commit distribution, normalized by max possible entropy.
 * Captures consistency of effort over time — the single hardest signal to fake.
 *
 * - Steady weekly commits → ~0.98
 * - Sporadic bursts → ~0.3-0.5
 * - Single code dump → ~0.0
 */
export function commitCadenceEntropy(weeklyCommits: readonly number[]): number {
  const total = weeklyCommits.reduce((sum, w) => sum + w, 0);
  if (total === 0) return 0;

  const numWeeks = weeklyCommits.length;
  if (numWeeks <= 1) return 0;

  let entropy = 0;
  for (const w of weeklyCommits) {
    if (w > 0) {
      const p = w / total;
      entropy -= p * Math.log2(p);
    }
  }

  const maxEntropy = Math.log2(numWeeks);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Compare second-half velocity to first-half velocity.
 * >1 = accelerating (good), ~1 = steady, <0.5 = decelerating, 0 = dead.
 * Returns normalized 0-1 score where 1 = steady or accelerating.
 */
export function velocityDecay(weeklyCommits: readonly number[]): number {
  const half = Math.floor(weeklyCommits.length / 2);
  const firstHalf = weeklyCommits.slice(0, half).reduce((s, w) => s + w, 0);
  const secondHalf = weeklyCommits.slice(half).reduce((s, w) => s + w, 0);

  if (firstHalf === 0 && secondHalf === 0) return 0;
  if (firstHalf === 0) return 1; // all activity in second half = new project

  const ratio = secondHalf / firstHalf;
  // Normalize: ratio of 1+ maps to 1.0, ratio of 0 maps to 0
  return clamp(ratio, 0, 2) / 2;
}

/**
 * How many contributors cover 80% of all commits?
 * Higher bus factor = more resilient project.
 */
export function busFactor(contributorCommits: readonly number[]): number {
  if (contributorCommits.length === 0) return 0;

  const total = contributorCommits.reduce((s, c) => s + c, 0);
  if (total === 0) return 0;

  const sorted = [...contributorCommits].sort((a, b) => b - a);
  let cumulative = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i]!;
    if (cumulative >= 0.8 * total) {
      // i+1 people cover 80% of commits
      return logNorm(i + 1, 10);
    }
  }
  return logNorm(sorted.length, 10);
}

/**
 * Gini coefficient of contributor commit distribution.
 * 0 = perfect equality, 1 = total inequality.
 * We return 1-gini so higher = more equal = better.
 */
export function contributionDiversity(contributorCommits: readonly number[]): number {
  const n = contributorCommits.length;
  if (n <= 1) return 0;

  const sorted = [...contributorCommits].sort((a, b) => a - b);
  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;

  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += (2 * i - n + 1) * sorted[i]!;
  }
  const gini = sum / (n * total);
  return clamp(1 - gini, 0, 1);
}

/**
 * Ratio of community commits to total commits.
 * High = community-driven, low = solo project.
 */
export function ownerCommunityRatio(
  ownerWeeklyCommits: readonly number[],
  allWeeklyCommits: readonly number[],
): number {
  const ownerTotal = ownerWeeklyCommits.reduce((s, w) => s + w, 0);
  const allTotal = allWeeklyCommits.reduce((s, w) => s + w, 0);
  if (allTotal === 0) return 0;
  return clamp((allTotal - ownerTotal) / allTotal, 0, 1);
}

/**
 * Sum of binary engineering practice flags, normalized to 0-1.
 */
export interface DisciplineFlags {
  readonly hasLicense: boolean;
  readonly hasContributing: boolean;
  readonly hasIssueTemplate: boolean;
  readonly hasPrTemplate: boolean;
  readonly hasCodeOfConduct: boolean;
  readonly hasCI: boolean;
  readonly hasReleases: boolean;
  readonly hasTopics: boolean;
  readonly hasDescription: boolean;
  readonly hasHomepage: boolean;
}

export function engineeringDiscipline(flags: DisciplineFlags): number {
  const booleans = [
    flags.hasLicense,
    flags.hasContributing,
    flags.hasIssueTemplate,
    flags.hasPrTemplate,
    flags.hasCodeOfConduct,
    flags.hasCI,
    flags.hasReleases,
    flags.hasTopics,
    flags.hasDescription,
    flags.hasHomepage,
  ];
  const count = booleans.filter(Boolean).length;
  return count / booleans.length;
}

/**
 * Measures how iteratively the code was built.
 * More commits per KB of code = more iterative development.
 * AI dumps have high size with very few commits.
 */
export function codeIterationDensity(sizeKb: number, totalCommits: number): number {
  if (sizeKb <= 0 || totalCommits <= 0) return 0;
  // commits per KB — higher = more iterative
  const density = totalCommits / sizeKb;
  return logNorm(density, 1); // threshold: 1 commit/KB is very iterative
}

/**
 * Fork-to-star ratio — forks indicate actual usage.
 */
export function forkStarRatio(forks: number, stars: number): number {
  if (stars <= 0) return 0;
  return logNorm(forks / stars, 0.5);
}

/**
 * Watcher-to-star ratio — watchers opt into notifications, much higher commitment.
 */
export function watcherStarRatio(watchers: number, stars: number): number {
  if (stars <= 0) return 0;
  return logNorm(watchers / stars, 0.1);
}

/**
 * Ratio of closed issues to total issues.
 */
export function issueCloseRatio(closedIssues: number, totalIssues: number): number {
  if (totalIssues <= 0) return 0.5; // no issues = neutral, not penalized
  return clamp(closedIssues / totalIssues, 0, 1);
}

/**
 * How recently the owner committed, based on the 52-week owner array.
 * Returns 1 if owner committed this week, decays toward 0.
 */
export function maintainerActivity(ownerWeeklyCommits: readonly number[]): number {
  // Find most recent week with owner commits (array index 0 = oldest, last = most recent)
  let weeksSinceActive = ownerWeeklyCommits.length; // default: no activity found
  for (let i = ownerWeeklyCommits.length - 1; i >= 0; i--) {
    if ((ownerWeeklyCommits[i] ?? 0) > 0) {
      weeksSinceActive = ownerWeeklyCommits.length - 1 - i;
      break;
    }
  }
  // 0 weeks since active → 1.0, 26+ weeks → ~0
  return 1 - logNorm(weeksSinceActive, 26);
}

/**
 * Stars per day, log-normalized. Separates steady organic growth from HN spikes.
 */
export function ageAdjustedStarRate(stars: number, createdAt: Date): number {
  const ageDays = Math.max(1, (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
  const starsPerDay = stars / ageDays;
  return logNorm(starsPerDay, 5);
}

// ============================================================================
// All Metrics Bundle
// ============================================================================

export interface AllMetrics {
  readonly cadenceEntropy: number;
  readonly velocityDecay: number;
  readonly busFactor: number;
  readonly contributionDiversity: number;
  readonly ownerCommunityRatio: number;
  readonly engineeringDiscipline: number;
  readonly codeIterationDensity: number;
  readonly forkStarRatio: number;
  readonly watcherStarRatio: number;
  readonly issueCloseRatio: number;
  readonly maintainerActivity: number;
  readonly ageAdjustedStarRate: number;
}

export interface SubScores {
  readonly maintenance: number;
  readonly community: number;
  readonly discipline: number;
  readonly substance: number;
}

export interface CompositeResult {
  readonly score: number;       // 0-100
  readonly subScores: SubScores;
  readonly flags: string[];
}

// ============================================================================
// Composite Score Calculator
// ============================================================================

interface PenaltyContext {
  readonly archived: boolean;
  readonly hasLicense: boolean;
  readonly totalCommits: number;
  readonly sizeKb: number;
}

function computePenalty(ctx: PenaltyContext, velocityDecayScore: number): number {
  let penalty = 1;
  if (ctx.archived) penalty *= 0.1;
  if (!ctx.hasLicense) penalty *= 0.8;
  // AI dump signal: <5 commits with >100KB
  if (ctx.totalCommits < 5 && ctx.sizeKb > 100) penalty *= 0.5;
  // Dead project: velocity near zero
  if (velocityDecayScore < 0.05) penalty *= 0.7;
  return penalty;
}

export function generateFlags(
  metrics: AllMetrics,
  penaltyCtx: PenaltyContext,
  contributorCount: number,
): string[] {
  const flags: string[] = [];

  if (penaltyCtx.archived) flags.push('archived');
  if (!penaltyCtx.hasLicense) flags.push('no-license');
  if (contributorCount <= 1) flags.push('single-maintainer');
  if (metrics.maintainerActivity < 0.3) flags.push('stale-6mo');
  if (metrics.busFactor > 0.5) flags.push('high-bus-factor');
  if (metrics.ownerCommunityRatio > 0.5) flags.push('active-community');
  if (penaltyCtx.totalCommits < 5 && penaltyCtx.sizeKb > 100) flags.push('ai-dump-signal');
  if (metrics.cadenceEntropy > 0.7) flags.push('consistent-commits');
  if (metrics.velocityDecay > 0.6) flags.push('growing');
  if (metrics.engineeringDiscipline > 0.6) flags.push('well-organized');

  return flags;
}

/**
 * Compute the composite "Gives a Damn" score from all metrics.
 *
 * Weights:
 *   Maintenance (35%): entropy 40%, velocity 35%, maintainer activity 25%
 *   Community (20%): owner ratio 30%, bus factor 35%, fork ratio 20%, watcher ratio 15%
 *   Discipline (25%): engineering index 50%, issue close 30%, has releases 20%
 *   Substance (15%): iteration density 50%, age-adjusted stars 50%
 *   + Anti-pattern penalties
 */
export function computeCompositeScore(
  metrics: AllMetrics,
  penaltyCtx: PenaltyContext,
  contributorCount: number,
): CompositeResult {
  // Sub-scores (each 0-1)
  const maintenance =
    metrics.cadenceEntropy * 0.40 +
    metrics.velocityDecay * 0.35 +
    metrics.maintainerActivity * 0.25;

  const community =
    metrics.ownerCommunityRatio * 0.30 +
    metrics.busFactor * 0.35 +
    metrics.forkStarRatio * 0.20 +
    metrics.watcherStarRatio * 0.15;

  const discipline =
    metrics.engineeringDiscipline * 0.50 +
    metrics.issueCloseRatio * 0.30 +
    (metrics.engineeringDiscipline > 0 ? 0.20 : 0); // has releases component baked into discipline

  const substance =
    metrics.codeIterationDensity * 0.50 +
    metrics.ageAdjustedStarRate * 0.50;

  // Weighted combination
  const raw =
    maintenance * 0.35 +
    community * 0.20 +
    discipline * 0.25 +
    substance * 0.15;

  // Apply penalties
  const penalty = computePenalty(penaltyCtx, metrics.velocityDecay);
  const score = Math.round(clamp(raw * penalty * 100, 0, 100));

  const flags = generateFlags(metrics, penaltyCtx, contributorCount);

  return {
    score,
    subScores: {
      maintenance: Math.round(maintenance * 100) / 100,
      community: Math.round(community * 100) / 100,
      discipline: Math.round(discipline * 100) / 100,
      substance: Math.round(substance * 100) / 100,
    },
    flags,
  };
}

// ============================================================================
// Convenience: Compute All Metrics from Raw Data
// ============================================================================

export interface RawRepoData {
  readonly stars: number;
  readonly forks: number;
  readonly watchers: number;
  readonly sizeKb: number;
  readonly createdAt: Date;
  readonly archived: boolean;
  readonly hasLicense: boolean;
  readonly closedIssues: number;
  readonly totalIssues: number;
  readonly totalCommits: number;
  readonly contributorCommits: readonly number[];
  readonly allWeeklyCommits: readonly number[];
  readonly ownerWeeklyCommits: readonly number[];
  readonly disciplineFlags: DisciplineFlags;
}

export function computeAllMetrics(data: RawRepoData): AllMetrics {
  return {
    cadenceEntropy: commitCadenceEntropy(data.allWeeklyCommits),
    velocityDecay: velocityDecay(data.allWeeklyCommits),
    busFactor: busFactor(data.contributorCommits),
    contributionDiversity: contributionDiversity(data.contributorCommits),
    ownerCommunityRatio: ownerCommunityRatio(data.ownerWeeklyCommits, data.allWeeklyCommits),
    engineeringDiscipline: engineeringDiscipline(data.disciplineFlags),
    codeIterationDensity: codeIterationDensity(data.sizeKb, data.totalCommits),
    forkStarRatio: forkStarRatio(data.forks, data.stars),
    watcherStarRatio: watcherStarRatio(data.watchers, data.stars),
    issueCloseRatio: issueCloseRatio(data.closedIssues, data.totalIssues),
    maintainerActivity: maintainerActivity(data.ownerWeeklyCommits),
    ageAdjustedStarRate: ageAdjustedStarRate(data.stars, data.createdAt),
  };
}

export function scoreRepo(data: RawRepoData): CompositeResult {
  const metrics = computeAllMetrics(data);
  return computeCompositeScore(
    metrics,
    {
      archived: data.archived,
      hasLicense: data.hasLicense,
      totalCommits: data.totalCommits,
      sizeKb: data.sizeKb,
    },
    data.contributorCommits.length,
  );
}
