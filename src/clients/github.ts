/**
 * GitHub API Client
 * GraphQL + REST client for fetching repository data for quality scoring.
 * Implements robust error handling that NEVER crashes.
 */

import { GITHUB, parseEnv } from '../config/index.js';
import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { calculateBackoff } from '../utils/retry.js';
import { pMapSettled } from '../utils/concurrency.js';
import { mcpLog } from '../utils/logger.js';

// ============================================================================
// Data Interfaces
// ============================================================================

export interface GitHubSearchItem {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly description: string | null;
  readonly stars: number;
  readonly forks: number;
  readonly language: string | null;
  readonly pushedAt: string;
  readonly url: string;
}

export interface ParticipationData {
  readonly all: readonly number[];
  readonly owner: readonly number[];
}

export interface ContributorEntry {
  readonly login: string;
  readonly contributions: number;
}

export interface RepoGraphQLData {
  readonly stars: number;
  readonly forks: number;
  readonly watchers: number;
  readonly openIssues: number;
  readonly closedIssues: number;
  readonly totalCommits: number;
  readonly totalReleases: number;
  readonly totalPRs: number;
  readonly sizeKb: number;
  readonly language: string | null;
  readonly license: string | null;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly pushedAt: string;
  readonly description: string | null;
  readonly homepage: string | null;
  readonly hasCI: boolean;
  readonly hasContributing: boolean;
  readonly hasIssueTemplate: boolean;
  readonly hasPrTemplate: boolean;
  readonly hasCodeOfConduct: boolean;
  readonly hasTopics: boolean;
}

export interface RepoFullData {
  readonly graphql: RepoGraphQLData;
  readonly participation: ParticipationData;
  readonly contributors: readonly ContributorEntry[];
}

// ============================================================================
// GraphQL Query
// ============================================================================

const REPO_DETAILS_QUERY = `
query RepoDetails($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    stargazerCount
    forkCount
    watchers { totalCount }
    openIssues: issues(states: OPEN) { totalCount }
    closedIssues: issues(states: CLOSED) { totalCount }
    pullRequests { totalCount }
    releases { totalCount }
    defaultBranchRef {
      target {
        ... on Commit {
          history { totalCount }
        }
      }
    }
    licenseInfo { spdxId }
    primaryLanguage { name }
    repositoryTopics(first: 5) {
      nodes { topic { name } }
    }
    isArchived
    pushedAt
    createdAt
    diskUsage
    description
    homepageUrl
    codeOfConduct { name }
    ciCheck: object(expression: "HEAD:.github/workflows") {
      ... on Tree { entries { name } }
    }
    contributingGuide: object(expression: "HEAD:CONTRIBUTING.md") {
      ... on Blob { byteSize }
    }
    issueTemplate: object(expression: "HEAD:.github/ISSUE_TEMPLATE") {
      ... on Tree { entries { name } }
    }
    prTemplate: object(expression: "HEAD:.github/PULL_REQUEST_TEMPLATE.md") {
      ... on Blob { byteSize }
    }
  }
}
`;

// ============================================================================
// Constants
// ============================================================================

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Try to get the GitHub token from `gh auth token` (GitHub CLI).
 * Returns empty string on failure — never throws.
 */
function getGhCliToken(): string {
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const token = execSync('gh auth token', {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    if (token.length > 0) {
      mcpLog('info', 'Using GitHub token from `gh auth token`', 'github');
    }
    return token;
  } catch {
    return '';
  }
}

// ============================================================================
// Client
// ============================================================================

export class GitHubClient {
  private token: string;
  private apiCallCount = 0;

  constructor(token?: string) {
    const env = parseEnv();
    this.token = token || env.GITHUB_TOKEN || getGhCliToken();

    if (!this.token) {
      throw new Error(
        'GitHub capability is not configured. Set GITHUB_TOKEN or log in with `gh auth login`.',
      );
    }
  }

  get apiCalls(): number {
    return this.apiCallCount;
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  async searchRepos(
    query: string,
    sort: string = 'stars',
    perPage: number = 20,
  ): Promise<{ items: GitHubSearchItem[]; totalCount: number; error?: StructuredError }> {
    const url = `${GITHUB.REST_BASE_URL}/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=${perPage}`;

    try {
      const response = await this.restGet(url);
      if ('error' in response) {
        return { items: [], totalCount: 0, error: response.error };
      }

      const data = response.data as {
        total_count?: number;
        items?: Array<Record<string, unknown>>;
      };

      const items: GitHubSearchItem[] = (data.items ?? []).map((item) => ({
        fullName: String(item.full_name ?? ''),
        owner: (item.owner as Record<string, unknown>)?.login
          ? String((item.owner as Record<string, unknown>).login)
          : '',
        name: String(item.name ?? ''),
        description: item.description ? String(item.description) : null,
        stars: Number(item.stargazers_count ?? 0),
        forks: Number(item.forks_count ?? 0),
        language: item.language ? String(item.language) : null,
        pushedAt: String(item.pushed_at ?? ''),
        url: String(item.html_url ?? ''),
      }));

      return { items, totalCount: Number(data.total_count ?? 0) };
    } catch (error) {
      return { items: [], totalCount: 0, error: classifyError(error) };
    }
  }

  // --------------------------------------------------------------------------
  // Fetch Full Repo Details (GraphQL + 2 REST)
  // --------------------------------------------------------------------------

  async fetchRepoDetails(
    owner: string,
    name: string,
  ): Promise<{ data?: RepoFullData; error?: StructuredError }> {
    // 1. GraphQL for bulk metadata
    const graphqlResult = await this.graphqlQuery(REPO_DETAILS_QUERY, { owner, name });
    if (graphqlResult.error || !graphqlResult.data) {
      return { error: graphqlResult.error ?? { code: ErrorCode.UNKNOWN_ERROR, message: 'GraphQL returned no data', retryable: false } };
    }

    const repo = (graphqlResult.data as { repository?: Record<string, unknown> })?.repository;
    if (!repo) {
      return { error: { code: ErrorCode.NOT_FOUND, message: `Repository ${owner}/${name} not found`, retryable: false } };
    }

    const graphql = parseGraphQLResponse(repo);

    // 2. REST: stats/participation (handles 202 retry)
    const participation = await this.fetchParticipation(owner, name);

    // 3. REST: contributors
    const contributors = await this.fetchContributors(owner, name);

    return {
      data: {
        graphql,
        participation,
        contributors,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Batch fetch with concurrency
  // --------------------------------------------------------------------------

  async fetchMultipleRepoDetails(
    repos: Array<{ owner: string; name: string }>,
  ): Promise<Array<{ owner: string; name: string; data?: RepoFullData; error?: StructuredError }>> {
    const results = await pMapSettled(
      repos,
      async (repo) => {
        const result = await this.fetchRepoDetails(repo.owner, repo.name);
        return { ...repo, ...result };
      },
      GITHUB.MAX_CONCURRENT_REPOS,
    );

    return results.map((settled, i) => {
      const repo = repos[i]!;
      if (settled.status === 'fulfilled') {
        return settled.value;
      }
      return {
        owner: repo.owner,
        name: repo.name,
        error: classifyError(settled.reason),
      };
    });
  }

  // --------------------------------------------------------------------------
  // GraphQL
  // --------------------------------------------------------------------------

  private async graphqlQuery(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data?: unknown; error?: StructuredError }> {
    this.apiCallCount++;

    for (let attempt = 0; attempt <= GITHUB.RETRY_COUNT; attempt++) {
      try {
        if (attempt > 0) {
          mcpLog('warning', `GraphQL retry ${attempt}/${GITHUB.RETRY_COUNT}`, 'github');
        }

        const response = await fetchWithTimeout(GITHUB.GRAPHQL_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'mcp-researchpowerpack',
          },
          body: JSON.stringify({ query, variables }),
          timeoutMs: GITHUB.TIMEOUT_MS,
        });

        if (!response.ok) {
          if (RETRYABLE_CODES.has(response.status) && attempt < GITHUB.RETRY_COUNT) {
            const delay = calculateBackoff(attempt);
            await sleep(delay);
            continue;
          }
          const text = await response.text().catch(() => '');
          return { error: classifyError({ status: response.status, message: text }) };
        }

        const json = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };

        if (json.errors && json.errors.length > 0) {
          const msg = json.errors.map((e) => e.message).join('; ');
          // GraphQL can return partial data with errors — use data if available
          if (json.data) {
            mcpLog('warning', `GraphQL partial error: ${msg}`, 'github');
            return { data: json.data };
          }
          return { error: { code: ErrorCode.INTERNAL_ERROR, message: msg, retryable: false } };
        }

        return { data: json.data };
      } catch (error) {
        const structured = classifyError(error);
        if (structured.retryable && attempt < GITHUB.RETRY_COUNT) {
          const delay = calculateBackoff(attempt);
          await sleep(delay);
          continue;
        }
        return { error: structured };
      }
    }

    return { error: { code: ErrorCode.UNKNOWN_ERROR, message: 'GraphQL failed after retries', retryable: false } };
  }

  // --------------------------------------------------------------------------
  // REST: Participation (handles 202 lazy computation)
  // --------------------------------------------------------------------------

  private async fetchParticipation(
    owner: string,
    name: string,
  ): Promise<ParticipationData> {
    const url = `${GITHUB.REST_BASE_URL}/repos/${owner}/${name}/stats/participation`;
    const emptyResult: ParticipationData = { all: [], owner: [] };

    for (let attempt = 0; attempt < GITHUB.PARTICIPATION_MAX_RETRIES; attempt++) {
      try {
        this.apiCallCount++;
        const response = await fetchWithTimeout(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'mcp-researchpowerpack',
          },
          timeoutMs: GITHUB.TIMEOUT_MS,
        });

        if (response.status === 202) {
          // GitHub is computing stats — retry after delay
          mcpLog('info', `Participation stats computing for ${owner}/${name}, retry ${attempt + 1}`, 'github');
          await sleep(GITHUB.PARTICIPATION_RETRY_DELAY_MS);
          continue;
        }

        if (!response.ok) {
          mcpLog('warning', `Participation fetch failed ${response.status} for ${owner}/${name}`, 'github');
          return emptyResult;
        }

        const data = (await response.json()) as { all?: number[]; owner?: number[] };
        if (!Array.isArray(data.all)) return emptyResult;

        return {
          all: data.all ?? [],
          owner: data.owner ?? [],
        };
      } catch (error) {
        mcpLog('warning', `Participation error for ${owner}/${name}: ${classifyError(error).message}`, 'github');
        return emptyResult;
      }
    }

    mcpLog('warning', `Participation still 202 after retries for ${owner}/${name}`, 'github');
    return emptyResult;
  }

  // --------------------------------------------------------------------------
  // REST: Contributors
  // --------------------------------------------------------------------------

  private async fetchContributors(
    owner: string,
    name: string,
  ): Promise<readonly ContributorEntry[]> {
    const url = `${GITHUB.REST_BASE_URL}/repos/${owner}/${name}/contributors?per_page=100&anon=true`;

    try {
      this.apiCallCount++;
      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'mcp-researchpowerpack',
        },
        timeoutMs: GITHUB.TIMEOUT_MS,
      });

      if (response.status === 202) {
        // Stats being computed — return empty, will degrade gracefully
        return [];
      }

      if (!response.ok) {
        mcpLog('warning', `Contributors fetch failed ${response.status} for ${owner}/${name}`, 'github');
        return [];
      }

      const data = (await response.json()) as Array<{ login?: string; contributions?: number }>;
      if (!Array.isArray(data)) return [];

      return data.map((c) => ({
        login: String(c.login ?? 'anonymous'),
        contributions: Number(c.contributions ?? 0),
      }));
    } catch (error) {
      mcpLog('warning', `Contributors error for ${owner}/${name}: ${classifyError(error).message}`, 'github');
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // REST helper
  // --------------------------------------------------------------------------

  private async restGet(
    url: string,
  ): Promise<{ data: unknown } | { error: StructuredError }> {
    this.apiCallCount++;

    for (let attempt = 0; attempt <= GITHUB.RETRY_COUNT; attempt++) {
      try {
        const response = await fetchWithTimeout(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'mcp-researchpowerpack',
          },
          timeoutMs: GITHUB.TIMEOUT_MS,
        });

        if (!response.ok) {
          if (RETRYABLE_CODES.has(response.status) && attempt < GITHUB.RETRY_COUNT) {
            const delay = calculateBackoff(attempt);
            await sleep(delay);
            continue;
          }
          const text = await response.text().catch(() => '');
          return { error: classifyError({ status: response.status, message: text }) };
        }

        return { data: await response.json() };
      } catch (error) {
        const structured = classifyError(error);
        if (structured.retryable && attempt < GITHUB.RETRY_COUNT) {
          const delay = calculateBackoff(attempt);
          await sleep(delay);
          continue;
        }
        return { error: structured };
      }
    }

    return { error: { code: ErrorCode.UNKNOWN_ERROR, message: 'REST request failed after retries', retryable: false } };
  }
}

// ============================================================================
// GraphQL Response Parser
// ============================================================================

function parseGraphQLResponse(repo: Record<string, unknown>): RepoGraphQLData {
  const defaultBranch = repo.defaultBranchRef as Record<string, unknown> | null;
  const target = defaultBranch?.target as Record<string, unknown> | null;
  const history = target?.history as { totalCount?: number } | null;

  const watchers = repo.watchers as { totalCount?: number } | null;
  const openIssues = repo.openIssues as { totalCount?: number } | null;
  const closedIssues = repo.closedIssues as { totalCount?: number } | null;
  const pullRequests = repo.pullRequests as { totalCount?: number } | null;
  const releases = repo.releases as { totalCount?: number } | null;
  const licenseInfo = repo.licenseInfo as { spdxId?: string } | null;
  const primaryLanguage = repo.primaryLanguage as { name?: string } | null;
  const topics = repo.repositoryTopics as { nodes?: Array<unknown> } | null;
  const codeOfConduct = repo.codeOfConduct as { name?: string } | null;

  // CI detection: check if .github/workflows directory has entries
  const ciCheck = repo.ciCheck as { entries?: Array<unknown> } | null;
  const hasCI = Array.isArray(ciCheck?.entries) && ciCheck.entries.length > 0;

  // Contributing guide
  const contributingGuide = repo.contributingGuide as { byteSize?: number } | null;
  const hasContributing = (contributingGuide?.byteSize ?? 0) > 0;

  // Issue template
  const issueTemplate = repo.issueTemplate as { entries?: Array<unknown> } | null;
  const hasIssueTemplate = Array.isArray(issueTemplate?.entries) && issueTemplate.entries.length > 0;

  // PR template
  const prTemplate = repo.prTemplate as { byteSize?: number } | null;
  const hasPrTemplate = (prTemplate?.byteSize ?? 0) > 0;

  return {
    stars: Number(repo.stargazerCount ?? 0),
    forks: Number(repo.forkCount ?? 0),
    watchers: watchers?.totalCount ?? 0,
    openIssues: openIssues?.totalCount ?? 0,
    closedIssues: closedIssues?.totalCount ?? 0,
    totalCommits: history?.totalCount ?? 0,
    totalReleases: releases?.totalCount ?? 0,
    totalPRs: pullRequests?.totalCount ?? 0,
    sizeKb: Number(repo.diskUsage ?? 0),
    language: primaryLanguage?.name ?? null,
    license: licenseInfo?.spdxId ?? null,
    archived: Boolean(repo.isArchived),
    createdAt: String(repo.createdAt ?? ''),
    pushedAt: String(repo.pushedAt ?? ''),
    description: repo.description ? String(repo.description) : null,
    homepage: repo.homepageUrl ? String(repo.homepageUrl) : null,
    hasCI,
    hasContributing,
    hasIssueTemplate,
    hasPrTemplate,
    hasCodeOfConduct: (codeOfConduct?.name ?? '').length > 0,
    hasTopics: (topics?.nodes?.length ?? 0) > 0,
  };
}
