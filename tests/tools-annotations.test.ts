import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const TEST_PROTOCOL_VERSION = '2025-11-25' as const;

function pnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function withRunningServer(
  port: number,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(pnpmCommand(), ['exec', 'tsx', 'index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_USE_ANONYMIZED_TELEMETRY: 'false',
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      ALLOWED_ORIGINS: baseUrl,
      SERPER_API_KEY: 'test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  try {
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch { /* not ready */ }
      await delay(200);
    }
    await fn(baseUrl);
  } catch (err) {
    throw new Error(`tools-annotations test failed.\nLogs:\n${logs}\n\n${String(err)}`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      delay(5000),
    ]);
  }
}

async function postJson(baseUrl: string, body: Record<string, unknown>, sessionId?: string): Promise<Response> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  });
  if (sessionId) {
    headers.set('Mcp-Session-Id', sessionId);
    headers.set('MCP-Protocol-Version', TEST_PROTOCOL_VERSION);
  }
  return fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function readJsonRpc(response: Response): Promise<any> {
  const raw = await response.text();
  try { return JSON.parse(raw); } catch {
    for (const event of raw.split('\n\n')) {
      const lines = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart());
      if (lines.length > 0) {
        try { return JSON.parse(lines.join('\n')); } catch { /* try next */ }
      }
    }
    throw new Error(`Could not parse: ${raw}`);
  }
}

test('gated tools advertise the start-research precondition', async () => {
  const port = 4100 + Math.floor(Math.random() * 200);
  await withRunningServer(port, async (baseUrl) => {
    const init = await postJson(baseUrl, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: TEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const sid = init.headers.get('mcp-session-id');
    await readJsonRpc(init);
    await postJson(baseUrl, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sid ?? undefined);

    const toolsJson = await readJsonRpc(await postJson(baseUrl, {
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    }, sid ?? undefined));

    const tools: Array<{ name: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }> = toolsJson.result.tools;
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const gated of ['web-search', 'scrape-links', 'get-reddit-post']) {
      const t = byName.get(gated);
      assert.ok(t, `expected ${gated} in tools/list`);
      // Either exposed via annotations.experimental.requires (preferred) or _meta.requires (spec escape hatch).
      const fromAnnotations = (t.annotations as { experimental?: { requires?: unknown } } | undefined)?.experimental?.requires;
      const fromMeta = t._meta?.requires;
      const requires = (fromAnnotations ?? fromMeta) as unknown[] | undefined;
      assert.ok(Array.isArray(requires), `${gated}: expected requires array on annotations.experimental or _meta`);
      assert.ok(requires?.includes('start-research'), `${gated}: requires should include start-research`);
    }

    // start-research itself must NOT carry the precondition.
    const startTool = byName.get('start-research');
    assert.ok(startTool);
    const startReq = ((startTool.annotations as { experimental?: { requires?: unknown } } | undefined)?.experimental?.requires) ?? startTool._meta?.requires;
    assert.equal(startReq, undefined, 'start-research should not require itself');
  });
});
