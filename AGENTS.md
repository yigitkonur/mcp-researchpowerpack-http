# AGENTS.md

Operating standard and architecture reference for AI agents working on this repository. `CLAUDE.md` is a symlink to this file — every folder resolves to the same content.

## What this repo is

`mcp-researchpowerpack` (v6+) — an HTTP-first MCP server built on `mcp-use` exposing **3 research tools**: `start-research`, `web-search`, `scrape-links`. ES-module TypeScript, published to npm and deployed via Manufact Cloud (`mcp-use deploy`).

`scrape-links` auto-detects `reddit.com/r/.../comments/` permalinks and routes them through the Reddit API (threaded post + comments). The dedicated `get-reddit-post` tool was merged into `scrape-links` in v6 — do not re-add it.

## Commands

```bash
pnpm install              # install dependencies
pnpm dev                  # local dev with watch (mcp-use dev, serves :3000/mcp)
pnpm build                # compile TypeScript → dist/ (mcp-use build)
pnpm start                # run compiled server
pnpm typecheck            # tsc --noEmit (strict mode)
pnpm test                 # unit tests + HTTP integration test
pnpm inspect              # launch mcp-use inspector against localhost:3000/mcp
pnpm deploy               # deploy to Manufact Cloud (mcp-use deploy)
```

Tests: `tsx --test tests/**/*.test.ts` (unit) + `tsx tests/http-server.ts` (integration — spawns the server and validates tool discovery / health endpoints over HTTP).

## mcp-use CLI reference

```
npx mcp-use [options] [command]

Commands:
  build          Build TypeScript and MCP UI widgets
  dev            Run development server with auto-reload and inspector
  start          Start production server
  login          Login to mcp-use cloud
  logout         Logout from Manufact cloud
  whoami         Show current user information
  org            Manage organizations
  deploy         Deploy MCP server from GitHub to Manufact cloud
  client         Interactive MCP client for terminal usage
  deployments    Manage cloud deployments
  servers        Manage cloud servers (Git-backed deploy targets)
  skills         Manage mcp-use AI agent skills
  generate-types Generate TypeScript type definitions for tools (.mcp-use/tool-registry.d.ts)
```

Deploy goes through GitHub → Manufact Cloud. No Railway. `.mcp-use/project.json` is `.gitignore`d but rewritten by `mcp-use deploy`. If a deploy fails with "uncommitted changes", run `git update-index --skip-worktree .mcp-use/project.json` once and retry.

## Architecture

```
index.ts                     Entry point: server startup, CORS, health, graceful shutdown
src/
  config/index.ts            Central config: env parsing, capability detection, constants
  clients/                   Provider API clients (search, reddit, scraper)
  tools/
    registry.ts              registerAllTools() — wires 3 tools + 2 prompts
    start-research.ts        goal-tailored brief + static playbook
    search.ts                web-search handler
    scrape.ts                scrape-links handler (reddit + web branches in parallel)
    mcp-helpers.ts           MCP response builders (markdown(), error(), toolFailure())
    utils.ts                 Shared formatters
  services/
    llm-processor.ts         AI extraction, classification, brief generation — primary + fallback model, always low reasoning
    markdown-cleaner.ts      HTML/markdown cleanup
  schemas/                   Zod input validation schemas per tool
  utils/
    errors.ts                Structured error codes with retryable classification
    concurrency.ts           pMap/pMapSettled — thin wrappers over p-map@7
    retry.ts                 Exponential backoff with jitter
    url-aggregator.ts        CTR-weighted URL ranking for web-search consensus
    response.ts              formatSuccess/formatError/formatBatchHeader
    logger.ts                mcpLog() — stderr-only logging (MCP-safe)
  version.ts                 Reads version from package.json at runtime
```

### Key patterns

- **Description-led tool routing**: no bootstrap gate. `start-research` is a strong recommendation via tool description, not a runtime precondition.
- **Capability detection**: `src/config/index.ts` evaluates which API keys are present at startup. Missing keys disable the affected tool gracefully (helpful error, no crash).
- **Lazy config via Proxy**: `LLM_EXTRACTION` uses a `Proxy` for deferred env reads — throws at first property access if required vars are missing.
- **Bounded concurrency**: All parallel work uses `pMap`/`pMapSettled` with explicit limits (scraper: 50, reddit: 50, LLM: 50).
- **Reddit + web parallelism in `scrape-links`**: Both branches run concurrently via `Promise.all`; results merge in original input order.
- **CTR-based URL ranking**: `web-search` scores URLs by CTR position weights and surfaces a static descending weight (`w=N`) to the LLM classifier.
- **Tools never throw**: Every tool handler wraps in try-catch, returning `toolFailure(errorMessage)` so `isError` flips correctly.
- **Structured errors**: `StructuredError` with `code`, `retryable`, `statusCode` fields.
- **Logging to stderr only**: `mcpLog()` writes to stderr to avoid polluting the MCP stdout protocol channel.

### Provider dependencies

| Tool | Required env var(s) |
|------|---------------------|
| `start-research` | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` (for goal-tailored brief) |
| `web-search` | `SERPER_API_KEY` |
| `scrape-links` (non-reddit URLs) | `SCRAPEDO_API_KEY` |
| `scrape-links` (reddit.com permalinks) | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| AI extraction + classification | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` |

## LLM configuration

All three of `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` are required together when LLM is enabled. No legacy aliases (`LLM_EXTRACTION_*`, `OPENROUTER_*`) — these were removed in v6. `reasoning_effort` is always `'low'` and is not configurable via env.

| Var | Required | Notes |
|-----|----------|-------|
| `LLM_API_KEY` | yes (for LLM features) | API key for the OpenAI-compatible endpoint |
| `LLM_BASE_URL` | yes (with LLM_API_KEY) | e.g. `https://your-server.up.railway.app/v1`, `https://api.openai.com/v1` |
| `LLM_MODEL` | yes (with LLM_API_KEY) | primary model — e.g. `gpt-5.4-mini` |
| `LLM_FALLBACK_MODEL` | no | used after primary exhausts all retries; gets 3 additional attempts — e.g. `gpt-5.4` |
| `LLM_CONCURRENCY` | no (default `50`) | parallel LLM calls (1–200) |

**Retry flow**: primary model gets `LLM_RETRY_CONFIG.maxRetries` (currently 2, so 3 total attempts). If all fail and `LLM_FALLBACK_MODEL` is set, fallback gets `FALLBACK_RETRY_COUNT` (currently 3) attempts with exponential backoff before the call is declared failed.

## TypeScript conventions

- Strict mode with `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- ES modules (`"type": "module"` in `package.json`, `NodeNext` module resolution)
- Zod v4 for runtime schema validation (schemas in `src/schemas/`)
- Tool identifiers use kebab-case (`web-search`, not `webSearch`)
- Node.js >=20.19.0 or >=22.12.0

## Build (remote — Mac mini)

All builds run on the Mac mini. Never build locally.

```bash
make up        # sync + build on mini (~7s incremental)
make test      # run tests on mini
make dev       # start MCP dev server on mini
make deploy    # deploy from mini
make info      # show detected config
```

## Branch + deploy contract

- Every push to `main` triggers auto-deploy to your linked Manufact server (configured in `.mcp-use/project.json`).
- After every push, verify the live `health://status.version` matches `package.json.version`. If the auto-deploy is stale, force it: `pnpm dlx mcp-use deploy --org <your-org-slug> -y`.
- Long-running feature work happens on a branch in a worktree at `/Users/yigitkonur/dev/mcp-researchpowerpack-http-revisions/`.
- Never push to `main` without running the verification chain in §"Before you push".
- Never push with `--no-verify`, `--force`, or `--no-gpg-sign` unless the user explicitly says so.

## Before you push

```bash
pnpm typecheck   # tsc --noEmit, strict mode
pnpm test:unit   # node:test across tests/*.test.ts
pnpm test:http   # spawns server on :3000 and exercises tools/list, prompts, resources, schemas
```

All three must pass. Fix before pushing.

## After you push — verify online with `test-by-mcpc-cli`

Use the `test-by-mcpc-cli` skill. Install if missing:

```bash
npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /test-by-mcpc-cli
```

### Standard smoke test

Replace `$MCP_URL` with your deployment URL:

```bash
mcpc connect "$MCP_URL" @rp
mcpc @rp ping
mcpc @rp tools-list --full | grep -E "name|requires"
mcpc @rp resources-read health://status
mcpc @rp close
```

Acceptance criteria (v6+):

| Check | Expected |
|---|---|
| `tools-list` count | exactly **3** — `start-research`, `web-search`, `scrape-links`. No `get-reddit-post`, no `search-reddit`. |
| `web-search` schema | exposes `scope: "web" \| "reddit" \| "both"` and `verbose: bool` |
| `health://status` body | includes `llm_planner_ok`, `llm_extractor_ok`, `planner_configured`, `extractor_configured`, `consecutive_planner_failures`, `consecutive_extractor_failures` |
| `initialize.capabilities` | includes `experimental.research_powerpack.{planner_available, extractor_available}` |
| `start-research` body | starts with the `run-research` skill install hint |
| `start-research` (no LLM) | emits compact degraded stub, not full playbook |
| `scrape-links` with a Reddit URL | routes via Reddit API; does NOT return `UNSUPPORTED_URL_TYPE` (that was a v5 behaviour — v6 handles Reddit in `scrape-links` directly) |

Note: the `/health` HTTP endpoint may return a simplified `{status, timestamp}` if the deployment is behind a proxy (e.g. Cloudflare). The MCP `health://status` resource bypasses that and returns the full payload.

## Companion skill — `run-research`

The [`run-research` skill](https://github.com/yigitkonur/skills-by-yigitkonur/tree/main/skills/run-research) teaches an agent how to spend these tools. Install once per machine:

```bash
npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /run-research
```

## Agent operating loop

1. **Read** — this file, `CHANGELOG.md`, and the relevant `docs/code-review/context/*` doc for the area you are touching.
2. **Plan** — write a task list (max 30 tasks, one active at a time, every task ends with `commit changes`). Outcome-first names.
3. **Implement** — strict mode, kebab-case tool names, never throw from tool handlers, route failures through `toolFailure(...)`.
4. **Verify locally** — typecheck + unit + http per §"Before you push".
5. **Commit + push** — small, intentional commits. Conventional Commits format.
6. **Verify online** — `mcpc` probe per §"After you push".
7. **Stop** — only when every acceptance criterion is green on the live URL.

## Don'ts

- Do not add new tools without explicit user direction.
- Do not re-add `get-reddit-post` or `search-reddit`. Reddit discovery in `scrape-links` (scope + URL routing) is the contract.
- Do not add legacy env var aliases (`LLM_EXTRACTION_*`, `OPENROUTER_*`) — they were intentionally removed in v6.
- Do not set `reasoning_effort` from env — it is hardcoded to `'low'`.
- Do not pass Reddit URLs to `scrape-links` as "unsupported" — v6 handles them.
- Do not assume in-memory state survives a deploy. The `InMemoryWorkflowStateStore` has a 24h TTL; Redis is the only durable store.
- Do not add cookie-cutter "Next Steps" footers with literal `[...]` placeholders.

## Where to look first

| Need | File |
|---|---|
| Architecture map | `docs/code-review/context/01-server-architecture-map.md` |
| Current tool surface | `docs/code-review/context/02-current-tool-surface.md` |
| LLM degradation paths | `docs/code-review/context/03-llm-degradation-paths.md` |
| Session + workflow state lifecycle | `docs/code-review/context/04-session-and-workflow-state.md` |
| Output formatting patterns | `docs/code-review/context/05-output-formatting-patterns.md` |
| mcp-use best practices | `docs/code-review/context/06-mcp-use-best-practices-primer.md` |
| Derailment evidence driving revisions | `docs/code-review/context/07-derailment-evidence.md` |
