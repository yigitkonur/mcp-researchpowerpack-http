<h1 align="center">🔬 MCP Research Powerpack</h1>

<p align="center">
  <strong>Five research tools for AI assistants — search, scrape, mine Reddit, and synthesize with LLMs.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mcp-research-powerpack"><img src="https://img.shields.io/npm/v/mcp-research-powerpack.svg?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://www.npmjs.com/package/mcp-research-powerpack"><img src="https://img.shields.io/npm/dm/mcp-research-powerpack.svg?style=flat-square&color=blue" alt="downloads"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-93450a.svg?style=flat-square" alt="node"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-grey.svg?style=flat-square" alt="license"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-5a67d8.svg?style=flat-square" alt="MCP"></a>
</p>

<p align="center">
  <code>npx mcp-research-powerpack</code>
</p>

---

An [MCP](https://modelcontextprotocol.io) server that gives Claude, Cursor, Windsurf, and any MCP-compatible AI assistant a complete research toolkit. Google search, Reddit deep-dives, web scraping with AI extraction, and multi-model deep research — all as tools that chain into each other.

Zero config to start. Each API key you add unlocks more capabilities.

## Tools

| Tool | What it does | Requires |
|:-----|:-------------|:---------|
| **`web_search`** | Parallel Google search across 3–100 keywords with CTR-weighted ranking and consensus detection | `SERPER_API_KEY` |
| **`search_reddit`** | Same search engine filtered to reddit.com — 10–50 queries in parallel | `SERPER_API_KEY` |
| **`get_reddit_post`** | Fetch 2–50 Reddit posts with full comment trees, smart comment budget allocation | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| **`scrape_links`** | Scrape 1–50 URLs with JS rendering fallback, HTML→Markdown, optional AI extraction | `SCRAPEDO_API_KEY` |
| **`deep_research`** | Send questions to research-capable models (Grok, Gemini) with web search, file attachments | `OPENROUTER_API_KEY` |

Tools are designed to **chain**: `web_search` → `scrape_links` → `search_reddit` → `get_reddit_post` → `deep_research` for synthesis. Each tool suggests the next logical step in its output.

## Quick Start

### Claude Desktop / Claude Code

Add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["-y", "mcp-research-powerpack"],
      "env": {
        "SERPER_API_KEY": "your-key-here",
        "OPENROUTER_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["-y", "mcp-research-powerpack"],
      "env": {
        "SERPER_API_KEY": "your-key-here"
      }
    }
  }
}
```

### From Source

```bash
git clone https://github.com/yigitkonur/mcp-research-powerpack.git
cd mcp-research-powerpack
pnpm install && pnpm build
pnpm start
```

### HTTP Transport

```bash
MCP_TRANSPORT=http MCP_PORT=3000 npx mcp-research-powerpack
```

Exposes `/mcp` endpoint (POST/GET/DELETE with session headers) and `/health`.

## API Keys

Each key unlocks a capability. Missing keys silently disable their tools — the server never crashes.

| Variable | Enables | Free Tier |
|:---------|:--------|:----------|
| `SERPER_API_KEY` | `web_search`, `search_reddit` | 2,500 searches/mo — [serper.dev](https://serper.dev) |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `get_reddit_post` | Unlimited — [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) (script type) |
| `SCRAPEDO_API_KEY` | `scrape_links` | 1,000 credits/mo — [scrape.do](https://scrape.do) |
| `OPENROUTER_API_KEY` | `deep_research`, LLM extraction | Pay-per-token — [openrouter.ai](https://openrouter.ai) |

## Configuration

Optional tuning via environment variables:

| Variable | Default | Description |
|:---------|:--------|:------------|
| `RESEARCH_MODEL` | `x-ai/grok-4-fast` | Primary deep research model |
| `RESEARCH_FALLBACK_MODEL` | `google/gemini-2.5-flash` | Fallback when primary fails |
| `LLM_EXTRACTION_MODEL` | `openai/gpt-oss-120b:nitro` | Model for scrape/reddit AI extraction |
| `DEFAULT_REASONING_EFFORT` | `high` | Research depth: `low`, `medium`, `high` |
| `DEFAULT_MAX_URLS` | `100` | Max search results per research question (10–200) |
| `API_TIMEOUT_MS` | `1800000` | Request timeout in ms (default: 30 min) |
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3000` | Port for HTTP mode |

## How It Works

### Search Ranking

Results from multiple queries are deduplicated by normalized URL and scored using **CTR-weighted position values** (position 1 = 100.0, position 10 = 12.56). URLs appearing across multiple queries get a consensus marker. Frequency threshold starts at ≥3, falls back to ≥2, then ≥1 to ensure results.

### Reddit Comment Budget

Global budget of **1,000 comments**, max 200 per post. After the first pass, surplus from posts with fewer comments is redistributed to truncated posts in a second fetch pass.

### Scraping Pipeline

**Three-mode fallback** per URL: basic → JS rendering → JS + US geo-targeting. Results go through HTML→Markdown conversion (Turndown), then optional AI extraction with a 100K char input cap and 8,000 token output per URL.

### Deep Research

**32,000 token budget** divided across questions (1 question = 32K, 10 questions = 3.2K each). Gemini models get `google_search` tool access. Grok/Perplexity get `search_parameters` with citations. Primary model fails → automatic fallback to secondary model.

### File Attachments

`deep_research` can read **local files** and include them as context. Files over 600 lines are smart-truncated (first 500 + last 100 lines). Line ranges supported. Line numbers preserved in output.

## Concurrency

| Operation | Parallel Limit |
|:----------|:---------------|
| Web search keywords | 8 |
| Reddit search queries | 8 |
| Reddit post fetches per batch | 5 (batches of 10) |
| URL scraping per batch | 10 (batches of 30) |
| LLM extraction | 3 |
| Deep research questions | 3 |

All clients use **manual retry with exponential backoff and jitter**. The OpenAI SDK's built-in retry is disabled (`maxRetries: 0`).

## Architecture

```
src/
├── index.ts                    Entry point — STDIO + HTTP transport, graceful shutdown
├── worker.ts                   Cloudflare Workers entry (Durable Objects)
├── config/
│   ├── index.ts                Env parsing, capability detection, lazy Proxy config
│   ├── loader.ts               YAML → Zod → JSON Schema pipeline
│   └── yaml/tools.yaml         Single source of truth for tool definitions
├── schemas/                    Zod input validation (deep-research, scrape-links, web-search)
├── tools/
│   ├── registry.ts             Tool lookup → capability check → validate → execute
│   ├── search.ts               web_search handler
│   ├── reddit.ts               search_reddit + get_reddit_post handlers
│   ├── scrape.ts               scrape_links handler
│   └── research.ts             deep_research handler
├── clients/
│   ├── search.ts               Google Serper API client
│   ├── reddit.ts               Reddit OAuth + comment tree parser
│   ├── scraper.ts              Scrape.do client with fallback modes
│   └── research.ts             OpenRouter client with model-specific handling
├── services/
│   ├── llm-processor.ts        Shared LLM extraction (singleton OpenAI client)
│   ├── markdown-cleaner.ts     HTML → Markdown via Turndown
│   └── file-attachment.ts      Local file reading with line ranges
└── utils/
    ├── retry.ts                Shared backoff + retry constants
    ├── concurrency.ts          Bounded parallel execution (pMap, pMapSettled)
    ├── url-aggregator.ts       CTR-weighted scoring + consensus detection
    ├── errors.ts               Error classification + structured errors
    ├── logger.ts               MCP logging protocol
    └── response.ts             Standardized 70/20/10 output formatting
```

## Deploy

### Cloudflare Workers

```bash
npx wrangler deploy
```

Uses Durable Objects with SQLite storage. YAML-based tool definitions are replaced with inline definitions since there's no filesystem in Workers.

### npm

Published as [`mcp-research-powerpack`](https://www.npmjs.com/package/mcp-research-powerpack). Binary names: `mcp-research-powerpack`, `research-powerpack-mcp`.

## Development

```bash
pnpm install          # Install dependencies
pnpm dev              # Run with tsx (live TypeScript)
pnpm build            # Compile to dist/
pnpm typecheck        # Type-check without emitting
pnpm start            # Run compiled output
```

### Testing

```bash
pnpm test:web-search     # Test web search tool
pnpm test:reddit-search  # Test Reddit search
pnpm test:scrape-links   # Test scraping
pnpm test:deep-research  # Test deep research
pnpm test:all            # Run all tests
pnpm test:check          # Check environment setup
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run `pnpm typecheck && pnpm build` to verify
5. Commit (`git commit -m 'feat: add amazing feature'`)
6. Push to your branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

[MIT](https://opensource.org/licenses/MIT) © [Yiğit Konur](https://github.com/yigitkonur)
