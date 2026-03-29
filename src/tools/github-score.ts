/**
 * GitHub Score Tool Handler
 * Searches GitHub repos by keywords, fetches detailed data, calculates quality metrics,
 * and returns a scored Markdown table.
 * NEVER throws — always returns structured response for graceful degradation.
 */

import type { MCPServer } from 'mcp-use/server';

import { getCapabilities, getMissingEnvMessage } from '../config/index.js';
import {
  githubScoreOutputSchema,
  githubScoreParamsSchema,
  type GitHubScoreParams,
  type GitHubScoreOutput,
} from '../schemas/github-score.js';
import { GitHubClient, type RepoFullData } from '../clients/github.js';
import {
  scoreRepo,
  type DisciplineFlags,
  type RawRepoData,
  type CompositeResult,
} from '../scoring/github-quality.js';
import { classifyError } from '../utils/errors.js';
import { mcpLog, formatError, formatDuration } from './utils.js';
import {
  createToolReporter,
  NOOP_REPORTER,
  toolFailure,
  toolSuccess,
  toToolResponse,
  type ToolExecutionResult,
  type ToolReporter,
} from './mcp-helpers.js';

// ============================================================================
// Internal Types
// ============================================================================

interface ScoredRepo {
  readonly fullName: string;
  readonly url: string;
  readonly stars: number;
  readonly forks: number;
  readonly openIssues: number;
  readonly language: string | null;
  readonly lastPush: string;
  readonly contributors: number;
  readonly archived: boolean;
  readonly score: CompositeResult;
}

// ============================================================================
// Helpers
// ============================================================================

function buildSearchQuery(params: GitHubScoreParams): string {
  let query: string;

  if (params.search_mode === 'OR') {
    query = params.keywords.join(' OR ');
  } else {
    // AND: space-separated terms
    query = params.keywords.join(' ');
  }

  if (params.min_stars > 0) {
    query += ` stars:>=${params.min_stars}`;
  }

  if (params.language) {
    query += ` language:${params.language}`;
  }

  return query;
}

function buildRawRepoData(
  fullData: RepoFullData,
): RawRepoData {
  const g = fullData.graphql;

  const disciplineFlags: DisciplineFlags = {
    hasLicense: g.license !== null,
    hasContributing: g.hasContributing,
    hasIssueTemplate: g.hasIssueTemplate,
    hasPrTemplate: g.hasPrTemplate,
    hasCodeOfConduct: g.hasCodeOfConduct,
    hasCI: g.hasCI,
    hasReleases: g.totalReleases > 0,
    hasTopics: g.hasTopics,
    hasDescription: (g.description ?? '').length > 0,
    hasHomepage: (g.homepage ?? '').length > 0,
  };

  return {
    stars: g.stars,
    forks: g.forks,
    watchers: g.watchers,
    sizeKb: g.sizeKb,
    createdAt: new Date(g.createdAt),
    archived: g.archived,
    hasLicense: g.license !== null,
    closedIssues: g.closedIssues,
    totalIssues: g.openIssues + g.closedIssues,
    totalCommits: g.totalCommits,
    contributorCommits: fullData.contributors.map((c) => c.contributions),
    allWeeklyCommits: fullData.participation.all,
    ownerWeeklyCommits: fullData.participation.owner,
    disciplineFlags,
  };
}

function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return 'unknown';

  const diffMs = Date.now() - date.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (days < 1) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

function formatStarCount(stars: number): string {
  if (stars >= 1000) {
    return `${(stars / 1000).toFixed(1)}k`;
  }
  return String(stars);
}

function scoreBand(score: number): string {
  if (score >= 70) return 'Excellent';
  if (score >= 50) return 'Good';
  if (score >= 30) return 'Meh';
  return 'Low';
}

function formatScoreTable(repos: ScoredRepo[]): string {
  let md = `| # | Repo | Stars | Score | Maint | Community | Discipline | Substance | Last Commit | Contributors | Flags |\n`;
  md += `|---|------|-------|-------|-------|-----------|------------|-----------|-------------|--------------|-------|\n`;

  repos.forEach((repo, i) => {
    const s = repo.score;
    const flagStr = s.flags.length > 0 ? s.flags.join(', ') : '-';
    md += `| ${i + 1} | [${repo.fullName}](${repo.url}) | ${formatStarCount(repo.stars)} | **${s.score}** | ${s.subScores.maintenance.toFixed(2)} | ${s.subScores.community.toFixed(2)} | ${s.subScores.discipline.toFixed(2)} | ${s.subScores.substance.toFixed(2)} | ${formatRelativeDate(repo.lastPush)} | ${repo.contributors} | ${flagStr} |\n`;
  });

  return md;
}

function sortRepos(repos: ScoredRepo[], sortBy: string): ScoredRepo[] {
  const sorted = [...repos];
  switch (sortBy) {
    case 'stars':
      sorted.sort((a, b) => b.stars - a.stars);
      break;
    case 'updated':
      sorted.sort(
        (a, b) =>
          new Date(b.lastPush).getTime() - new Date(a.lastPush).getTime(),
      );
      break;
    case 'score':
    default:
      sorted.sort((a, b) => b.score.score - a.score.score);
      break;
  }
  return sorted;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleGitHubScore(
  params: GitHubScoreParams,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<GitHubScoreOutput>> {
  const startTime = Date.now();

  try {
    const client = new GitHubClient();
    const query = buildSearchQuery(params);

    mcpLog('info', `Searching GitHub: "${query}"`, 'github-score');
    await reporter.log('info', `Searching GitHub for: ${query}`);
    await reporter.progress(10, 100, 'Searching GitHub repositories');

    // 1. Search
    const searchResult = await client.searchRepos(query, 'stars', params.max_results);
    if (searchResult.error) {
      return buildGitHubScoreError(searchResult.error, query, startTime, client.apiCalls);
    }

    if (searchResult.items.length === 0) {
      const emptyMd = `# GitHub Score: No Results\n\nQuery: \`${query}\`\n\nNo repositories found. Try broader keywords or lower the min_stars filter.`;
      return toolSuccess(emptyMd, {
        content: emptyMd,
        metadata: {
          query,
          total_found: 0,
          total_scored: 0,
          failed_scores: 0,
          execution_time_ms: Date.now() - startTime,
          api_calls_made: client.apiCalls,
        },
        repos: [],
      });
    }

    mcpLog('info', `Found ${searchResult.totalCount} repos, scoring top ${searchResult.items.length}`, 'github-score');
    await reporter.progress(20, 100, `Found ${searchResult.items.length} repos, fetching details`);

    // 2. Fetch detailed data + score
    const repoRequests = searchResult.items.map((item) => ({
      owner: item.owner,
      name: item.name,
    }));

    const detailResults = await client.fetchMultipleRepoDetails(repoRequests);

    const scoredRepos: ScoredRepo[] = [];
    let failedCount = 0;

    for (let i = 0; i < detailResults.length; i++) {
      const detail = detailResults[i]!;
      const searchItem = searchResult.items[i]!;

      if (detail.error || !detail.data) {
        failedCount++;
        mcpLog('warning', `Failed to score ${searchItem.fullName}: ${detail.error?.message ?? 'unknown'}`, 'github-score');
        continue;
      }

      try {
        const rawData = buildRawRepoData(detail.data);
        const score = scoreRepo(rawData);

        scoredRepos.push({
          fullName: searchItem.fullName,
          url: searchItem.url,
          stars: detail.data.graphql.stars,
          forks: detail.data.graphql.forks,
          openIssues: detail.data.graphql.openIssues,
          language: detail.data.graphql.language,
          lastPush: detail.data.graphql.pushedAt,
          contributors: detail.data.contributors.length,
          archived: detail.data.graphql.archived,
          score,
        });
      } catch {
        failedCount++;
        mcpLog('warning', `Scoring error for ${searchItem.fullName}`, 'github-score');
      }

      // Progress: 20-90% range during scoring
      const progress = 20 + Math.round(((i + 1) / detailResults.length) * 70);
      await reporter.progress(progress, 100, `Scored ${i + 1}/${detailResults.length} repos`);
    }

    // 3. Sort
    const sorted = sortRepos(scoredRepos, params.sort);

    // 4. Build output
    const executionTime = Date.now() - startTime;
    const avgScore =
      sorted.length > 0
        ? Math.round(sorted.reduce((s, r) => s + r.score.score, 0) / sorted.length)
        : 0;

    let md = `# GitHub Score Report\n\n`;
    md += `**Query:** \`${query}\` | **Sorted by:** ${params.sort} | **Scored:** ${sorted.length}/${searchResult.items.length}`;
    if (failedCount > 0) md += ` | **Failed:** ${failedCount}`;
    md += `\n\n`;
    md += `**Average Score:** ${avgScore}/100 (${scoreBand(avgScore)})\n\n`;
    md += formatScoreTable(sorted);
    md += `\n---\n`;
    md += `*${formatDuration(executionTime)} | ${client.apiCalls} API calls | Score legend: Maint=Maintenance Pulse, Community=Community Health, Discipline=Engineering Practices, Substance=Code Quality*\n`;
    md += `\n**Score bands:** 70+ Excellent | 50-69 Good | 30-49 Meh | <30 Low\n`;
    md += `\n**Flag legend:** consistent-commits (steady work), growing (accelerating), active-community (external contributors), well-organized (CI/license/templates), high-bus-factor (multiple key contributors), stale-6mo (owner inactive), single-maintainer, no-license, archived, ai-dump-signal (few commits + large codebase)`;

    const structuredRepos = sorted.map((r) => ({
      full_name: r.fullName,
      url: r.url,
      stars: r.stars,
      forks: r.forks,
      open_issues: r.openIssues,
      language: r.language,
      last_push: r.lastPush,
      contributors: r.contributors,
      archived: r.archived,
      composite_score: r.score.score,
      maintenance_score: r.score.subScores.maintenance,
      community_score: r.score.subScores.community,
      discipline_score: r.score.subScores.discipline,
      substance_score: r.score.subScores.substance,
      flags: r.score.flags,
    }));

    return toolSuccess(md, {
      content: md,
      metadata: {
        query,
        total_found: searchResult.totalCount,
        total_scored: sorted.length,
        failed_scores: failedCount,
        execution_time_ms: executionTime,
        api_calls_made: client.apiCalls,
      },
      repos: structuredRepos,
    });
  } catch (error) {
    return buildGitHubScoreError(classifyError(error), buildSearchQuery(params), startTime, 0);
  }
}

// ============================================================================
// Error Formatting
// ============================================================================

function buildGitHubScoreError(
  error: unknown,
  query: string,
  startTime: number,
  apiCalls: number,
): ToolExecutionResult<GitHubScoreOutput> {
  const structuredError = typeof error === 'object' && error !== null && 'code' in error
    ? error as { code: string; message: string; retryable: boolean }
    : classifyError(error);

  mcpLog('error', `github-score: ${structuredError.message}`, 'github-score');

  const errorContent = formatError({
    code: structuredError.code,
    message: structuredError.message,
    retryable: structuredError.retryable,
    toolName: 'github-score',
    howToFix: [
      'Verify GITHUB_TOKEN is set correctly',
      'Check that the token has not expired',
      'Ensure you have not exceeded the GitHub API rate limit (5000 req/hr)',
    ],
    alternatives: [
      'web-search(keywords=["topic github"]) — search the web for GitHub repos instead',
    ],
  });

  return toolFailure(
    `${errorContent}\n\nQuery: ${query}\nExecution time: ${formatDuration(Date.now() - startTime)}\nAPI calls: ${apiCalls}`,
  );
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerGitHubScoreTool(server: MCPServer): void {
  server.tool(
    {
      name: 'github-score',
      title: 'GitHub Score',
      description:
        'Search GitHub repositories and score them with a composite "Gives a Damn" quality metric. ' +
        'Takes keywords with AND/OR logic, fetches repo metadata, commit patterns, contributor data, ' +
        'and CI/release/template presence to compute a 0-100 quality score across 4 dimensions: ' +
        'Maintenance (commit consistency, velocity, owner activity), Community (contributor diversity, bus factor), ' +
        'Discipline (CI, releases, license, templates), and Substance (code iteration density, growth). ' +
        'Returns a scored Markdown table and structured data. Requires GITHUB_TOKEN.',
      schema: githubScoreParamsSchema,
      outputSchema: githubScoreOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      if (!getCapabilities().github) {
        return toToolResponse(toolFailure(getMissingEnvMessage('github')));
      }

      const reporter = createToolReporter(ctx, 'github-score');
      const result = await handleGitHubScore(args, reporter);

      await reporter.progress(
        100,
        100,
        result.isError ? 'GitHub scoring failed' : 'GitHub scoring complete',
      );
      return toToolResponse(result);
    },
  );
}
