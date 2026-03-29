/**
 * GitHub Score Tool — Zod Input/Output Schemas
 */

import { z } from 'zod';

// ============================================================================
// Input Schema
// ============================================================================

const keywordSchema = z
  .string({ error: 'github-score: Keyword is required' })
  .min(1, { message: 'github-score: Keyword cannot be empty' })
  .max(256, { message: 'github-score: Keyword too long (max 256 characters)' })
  .describe(
    'A GitHub search term. Each keyword is used in the GitHub repository search API. Examples: "mcp server", "web scraping tool", "langchain agent".',
  );

export const githubScoreParamsSchema = z
  .object({
    keywords: z
      .array(keywordSchema)
      .min(1, { message: 'github-score: At least 1 keyword required' })
      .max(10, { message: 'github-score: Maximum 10 keywords allowed' })
      .describe(
        'Array of 1–10 search keywords. Combined with search_mode to form the GitHub search query. Example: ["mcp", "research tool"] with AND mode searches for repos matching both terms.',
      ),
    search_mode: z
      .enum(['AND', 'OR'])
      .default('AND')
      .describe(
        'How to combine keywords: AND requires all terms present, OR matches any term. Default: AND.',
      ),
    min_stars: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe('Minimum star count filter. Repos with fewer stars are excluded. Default: 0.'),
    language: z
      .string()
      .max(50)
      .optional()
      .describe(
        'Optional language filter (e.g., "TypeScript", "Python"). Matches the GitHub repository primary language.',
      ),
    max_results: z
      .number()
      .int()
      .min(1, { message: 'github-score: At least 1 result required' })
      .max(50, { message: 'github-score: Maximum 50 results allowed' })
      .default(20)
      .describe(
        'How many repos to fetch and score. Default: 20, max: 50. More repos = longer execution time (~3 API calls per repo).',
      ),
    sort: z
      .enum(['stars', 'updated', 'score'])
      .default('score')
      .describe(
        'Sort the output table by: "stars" (raw star count), "updated" (most recently pushed), or "score" (composite quality score). Default: "score".',
      ),
  })
  .strict();

export type GitHubScoreParams = z.infer<typeof githubScoreParamsSchema>;

// ============================================================================
// Output Schema
// ============================================================================

const repoScoreSchema = z
  .object({
    full_name: z.string().describe('Full "owner/repo" identifier.'),
    url: z.string().describe('GitHub repository URL.'),
    stars: z.number().int().nonnegative().describe('Star count.'),
    forks: z.number().int().nonnegative().describe('Fork count.'),
    open_issues: z.number().int().nonnegative().describe('Open issue count.'),
    language: z.string().nullable().describe('Primary programming language.'),
    last_push: z.string().describe('Date of the last push in ISO 8601 format.'),
    contributors: z.number().int().nonnegative().describe('Number of contributors (up to 100).'),
    archived: z.boolean().describe('Whether the repo is archived.'),
    composite_score: z
      .number()
      .min(0)
      .max(100)
      .describe('Composite "Gives a Damn" quality score (0–100).'),
    maintenance_score: z.number().min(0).max(1).describe('Maintenance pulse sub-score (0–1).'),
    community_score: z.number().min(0).max(1).describe('Community health sub-score (0–1).'),
    discipline_score: z.number().min(0).max(1).describe('Engineering discipline sub-score (0–1).'),
    substance_score: z.number().min(0).max(1).describe('Code substance sub-score (0–1).'),
    flags: z
      .array(z.string())
      .describe(
        'Key quality flags (e.g., "archived", "no-license", "single-maintainer", "active-community").',
      ),
  })
  .strict();

export const githubScoreOutputSchema = z
  .object({
    content: z
      .string()
      .describe('Formatted Markdown report with scored repository table and analysis.'),
    metadata: z
      .object({
        query: z.string().describe('The GitHub search query that was executed.'),
        total_found: z
          .number()
          .int()
          .nonnegative()
          .describe('Total repos found by GitHub search.'),
        total_scored: z
          .number()
          .int()
          .nonnegative()
          .describe('Number of repos successfully scored.'),
        failed_scores: z
          .number()
          .int()
          .nonnegative()
          .describe('Number of repos where scoring failed.'),
        execution_time_ms: z
          .number()
          .int()
          .nonnegative()
          .describe('Total execution time in milliseconds.'),
        api_calls_made: z
          .number()
          .int()
          .nonnegative()
          .describe('Total GitHub API calls made.'),
      })
      .strict()
      .describe('Structured metadata about the GitHub score batch.'),
    repos: z
      .array(repoScoreSchema)
      .describe('Array of scored repositories with individual metrics.'),
  })
  .strict();

export type GitHubScoreOutput = z.infer<typeof githubScoreOutputSchema>;
