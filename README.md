# mcp-researchpowerpack

http mcp server for research. web search, reddit mining, scraping, github scoring — all over `/mcp`.

built on [mcp-use](https://github.com/nicepkg/mcp-use). no stdio, http only.

## tools

| tool | what it does | needs |
|------|-------------|-------|
| `web-search` | parallel google search across 3–100 keywords, ctr-weighted url ranking | `SERPER_API_KEY` |
| `search-reddit` | reddit-focused search, 3–50 diverse queries | `SERPER_API_KEY` |
| `get-reddit-post` | fetch reddit posts + full comment trees, 2–50 urls | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| `scrape-links` | scrape 1–50 urls with optional ai extraction | `SCRAPEDO_API_KEY` |
| `github-score` | evaluate github repo quality with multi-signal scoring | `GITHUB_TOKEN` |

also exposes `/health` and `health://status` mcp resource.

## quickstart

```bash
# from npm
HOST=127.0.0.1 PORT=3000 npx -y mcp-researchpowerpack-http

# from source
git clone https://github.com/yigitkonur/mcp-researchpowerpack-http.git
cd mcp-researchpowerpack-http
pnpm install && pnpm dev
```

connect your client to `http://localhost:3000/mcp`:

```json
{
  "mcpServers": {
    "research-powerpack": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## config

copy `.env.example`, set only what you need. missing keys don't crash — they disable the tool with a clear error.

### server

| var | default | |
|-----|---------|---|
| `PORT` | `3000` | http port |
| `HOST` | `127.0.0.1` | bind address |
| `ALLOWED_ORIGINS` | unset | comma-separated origins for host validation |
| `REDIS_URL` | unset | redis-backed sessions + distributed sse |

### providers

| var | enables |
|-----|---------|
| `SERPER_API_KEY` | web-search, search-reddit |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | get-reddit-post |
| `SCRAPEDO_API_KEY` | scrape-links |
| `OPENROUTER_API_KEY` | ai extraction (scrape-links) |

optional tuning: `LLM_EXTRACTION_MODEL`, `API_TIMEOUT_MS`.

## dev

```bash
pnpm install
pnpm dev          # watch mode, serves :3000/mcp
pnpm typecheck    # tsc --noEmit
pnpm test         # http integration test
pnpm build        # compile to dist/
pnpm inspect      # mcp-use inspector
```

## deploy

```bash
pnpm build
pnpm deploy       # manufact cloud
```

or self-host anywhere with node 20.19+ / 22.12+:

```bash
HOST=0.0.0.0 ALLOWED_ORIGINS=https://app.example.com pnpm start
```

## architecture

```
index.ts                 server startup, cors, health, shutdown
src/
  config/                env parsing, capability detection, lazy proxy config
  clients/               provider api clients (serper, reddit, scrapedo, openrouter)
  tools/
    registry.ts          registerAllTools() — wires tools to mcp server
    search.ts            web-search handler
    reddit.ts            search-reddit + get-reddit-post
    scrape.ts            scrape-links handler
    github-score.ts      github-score handler
    mcp-helpers.ts       response builders (markdown, error, toolFailure)
    utils.ts             shared formatters, token budget allocation
  services/
    llm-processor.ts     ai extraction/synthesis via openrouter
    markdown-cleaner.ts  html/markdown cleanup
  schemas/               zod v4 input validation per tool
  utils/
    errors.ts            structured error codes (retryable classification)
    concurrency.ts       pMap/pMapSettled — bounded parallel execution
    retry.ts             exponential backoff with jitter
    url-aggregator.ts    ctr-weighted url ranking for search consensus
    response.ts          formatSuccess/formatError/formatBatchHeader
    logger.ts            mcpLog() — stderr-only (mcp-safe)
```

key patterns: capability detection at startup, lazy config via proxy, bounded concurrency (scraper:30, reddit:10, github:5), 32k token budgets, ctr-based url ranking, tools never throw (always return toolFailure), structured errors with retry classification.

## license

mit
