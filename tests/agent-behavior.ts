import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import OpenAI from 'openai';

const prompts = [
  'Find current MCP server OAuth frameworks',
  'Compare TypeScript MCP server libraries for auth',
  'Find Reddit discussions about MCP deployment issues',
  'Research pricing changes for a developer tool',
] as const;

const sourceFetchToolName = 'scrape-links';
const removedToolNames = ['get-reddit-post', 'search-reddit'] as const;
const removedToolNameSet: ReadonlySet<string> = new Set(removedToolNames);

type RemovedToolName = (typeof removedToolNames)[number];

interface McpCall {
  name: string;
  arguments: string;
  error?: string | null;
  output?: string | null;
}

interface EvalTrace {
  prompt: string;
  responseId?: string;
  outputText?: string;
  firstToolName?: string;
  maxWebSearchQueries: number;
  chainedToSourceFetch: boolean;
  removedToolCalls: RemovedToolName[];
  invalidBehaviorIssues: string[];
  mcpCalls: McpCall[];
  error?: string;
}

function isRemovedToolName(toolName: string): toolName is RemovedToolName {
  return removedToolNameSet.has(toolName);
}

function parseQueryCount(argumentsJson: string): number {
  try {
    const parsed = JSON.parse(argumentsJson) as { queries?: unknown };
    return Array.isArray(parsed.queries) ? parsed.queries.length : 0;
  } catch {
    return 0;
  }
}

async function runPromptEval(
  client: OpenAI,
  model: string,
  baseUrl: string,
  prompt: string,
): Promise<EvalTrace> {
  try {
    const response = await client.responses.create({
      model,
      input: `Use the MCP server tools to research this request and answer it: ${prompt}`,
      tools: [
        {
          type: 'mcp',
          server_label: 'research',
          server_url: baseUrl,
          require_approval: 'never',
        },
      ],
    });

    const mcpCalls = response.output
      .filter((item): item is Extract<typeof item, { type: 'mcp_call' }> => item.type === 'mcp_call')
      .map((item) => ({
        name: item.name,
        arguments: item.arguments,
        error: item.error,
        output: item.output,
      }));

    const removedToolCalls = mcpCalls
      .map((call) => call.name)
      .filter(isRemovedToolName);
    const invalidBehaviorIssues = removedToolCalls.map(
      (toolName) => `Removed v6 tool called: ${toolName}; use ${sourceFetchToolName}.`,
    );

    return {
      prompt,
      responseId: response.id,
      outputText: response.output_text,
      firstToolName: mcpCalls[0]?.name,
      maxWebSearchQueries: Math.max(
        0,
        ...mcpCalls
          .filter((call) => call.name === 'web-search')
          .map((call) => parseQueryCount(call.arguments)),
      ),
      chainedToSourceFetch: mcpCalls.some((call) => call.name === sourceFetchToolName),
      removedToolCalls,
      invalidBehaviorIssues,
      mcpCalls,
    };
  } catch (error) {
    return {
      prompt,
      maxWebSearchQueries: 0,
      chainedToSourceFetch: false,
      removedToolCalls: [],
      invalidBehaviorIssues: [],
      mcpCalls: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.EVAL_MCP_URL ?? 'http://localhost:3000/mcp';
  const model = process.env.EVAL_MODEL ?? 'gpt-4.1-mini';
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.EVAL_API_KEY;
  const startedAt = new Date().toISOString();

  await mkdir('test-results/eval-runs', { recursive: true });
  const artifactPath = join(
    'test-results/eval-runs',
    `${startedAt.replace(/[:]/g, '-')}.json`,
  );

  if (!apiKey) {
    const skippedRun = {
      startedAt,
      baseUrl,
      model,
      prompts,
      status: 'skipped-no-api-key',
      note: '[TEMP] Set OPENAI_API_KEY or EVAL_API_KEY to execute live evals.',
      metrics: {
        orientationFirstRate: 0,
        averageQueryDepth: 0,
        chainingRate: 0,
      },
      traces: [],
    };

    await writeFile(artifactPath, JSON.stringify(skippedRun, null, 2));

    console.log(`EVAL artifact: ${artifactPath}`);
    console.log('| metric | current |');
    console.log('|---|---:|');
    console.log('| orientationFirst | 0.00 |');
    console.log('| queryDepth | 0.00 |');
    console.log('| chaining | 0.00 |');
    console.log('EVAL status: skipped-no-api-key');
    return;
  }

  const client = new OpenAI({ apiKey });
  const traces: EvalTrace[] = [];

  for (const prompt of prompts) {
    traces.push(await runPromptEval(client, model, baseUrl, prompt));
  }

  const orientationFirstPasses = traces.filter((trace) => trace.firstToolName === 'start-research').length;
  const averageQueryDepth = traces.reduce((sum, trace) => sum + trace.maxWebSearchQueries, 0) / traces.length;
  const chainingPasses = traces.filter((trace) => trace.chainedToSourceFetch).length;
  const invalidBehaviorIssues = traces.flatMap((trace) => trace.invalidBehaviorIssues);
  const invalidRemovedToolCallTraces = traces.filter((trace) => trace.removedToolCalls.length > 0).length;
  const status = invalidBehaviorIssues.length > 0 ? 'failed-invalid-tool-call' : 'completed';

  const run = {
    startedAt,
    baseUrl,
    model,
    prompts,
    status,
    metrics: {
      orientationFirstRate: orientationFirstPasses / traces.length,
      averageQueryDepth,
      chainingRate: chainingPasses / traces.length,
    },
    invalidBehavior: {
      removedToolCallTraceCount: invalidRemovedToolCallTraces,
      issues: invalidBehaviorIssues,
    },
    traces,
  };

  await writeFile(artifactPath, JSON.stringify(run, null, 2));

  console.log(`EVAL artifact: ${artifactPath}`);
  console.log('| metric | current |');
  console.log('|---|---:|');
  console.log(`| orientationFirst | ${run.metrics.orientationFirstRate.toFixed(2)} |`);
  console.log(`| queryDepth | ${run.metrics.averageQueryDepth.toFixed(2)} |`);
  console.log(`| chaining | ${run.metrics.chainingRate.toFixed(2)} |`);
  console.log(`EVAL status: ${run.status}`);

  if (invalidBehaviorIssues.length > 0) {
    process.exitCode = 1;
  }
}

void main();
