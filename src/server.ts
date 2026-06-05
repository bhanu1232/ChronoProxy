/**
 * server.ts — ChronoProxy API Server
 *
 * A lightweight, production-grade headless semantic browser proxy.
 * Streams semantic text tokens from any URL with O(1) memory usage.
 *
 * Endpoints:
 *   GET  /              — API index (JSON)
 *   POST /v1/browse     — Fetch a URL and stream semantic tokens
 *   GET  /v1/health     — Liveness + pool + memory stats (JSON)
 *   GET  /v1/metrics    — Prometheus text-format metrics
 *   POST /v1/credentials/:service — Store an encrypted API key
 *   GET  /v1/credentials          — List stored service names
 *   DELETE /v1/credentials/:service — Remove a stored key
 */

import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { browserPool } from './pool';
import { SemanticPrunerStream } from './pruner';
import { rateLimitHook, closeRedis } from './ratelimit';
import { bootstrapSchema, upsertCredential, getCredential, deleteCredential, listServices, closeDb } from './db';

// ── Server ────────────────────────────────────────────────────────────────────

const fastify = Fastify({
  logger: false,
  trustProxy: true,
  bodyLimit: 1_048_576,     // 1 MB max body
  connectionTimeout: 30_000,
  keepAliveTimeout: 5_000,
});

// ── Telemetry counters ────────────────────────────────────────────────────────

let totalRequests = 0;
let totalErrors   = 0;
let totalTokens   = 0;

// ── GET / — API index ─────────────────────────────────────────────────────────

fastify.get('/', async (_req, reply) => {
  const port = process.env['PORT'] ?? '8080';
  const base = `http://localhost:${port}`;
  return reply.send({
    name:    'ChronoProxy',
    version: '1.0.0',
    description: 'Headless semantic browser proxy — streams clean text tokens from any URL',
    endpoints: {
      browse:          { method: 'POST', path: `${base}/v1/browse`,           body: '{ "url": "https://..." }' },
      health:          { method: 'GET',  path: `${base}/v1/health`  },
      metrics:         { method: 'GET',  path: `${base}/v1/metrics` },
      storeCredential: { method: 'POST', path: `${base}/v1/credentials`,           body: '{ "service": "name", "apiKey": "key" }' },
      listCredentials: { method: 'GET',  path: `${base}/v1/credentials` },
      delCredential:   { method: 'DELETE', path: `${base}/v1/credentials/:service` },
    },
  });
});

// ── POST /v1/browse ───────────────────────────────────────────────────────────

fastify.post<{ Body: { url?: string; waitUntil?: string } }>(
  '/v1/browse',
  { preHandler: rateLimitHook },
  async (request, reply) => {
    const { url, waitUntil = 'domcontentloaded' } = request.body ?? {};

    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'Body field "url" is required' });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only http/https URLs are supported');
      }
    } catch (e: any) {
      return reply.status(400).send({ error: `Invalid URL: ${e.message}` });
    }

    totalRequests++;
    const bundle = await browserPool.acquire().catch((err) => {
      totalErrors++;
      reply.status(503).send({ error: `Browser pool unavailable: ${err.message}` });
      return null;
    });
    if (!bundle) return;

    const page = await bundle.context.newPage();

    try {
      const validWaitUntil = ['commit', 'domcontentloaded', 'load', 'networkidle'].includes(waitUntil)
        ? (waitUntil as 'commit' | 'domcontentloaded' | 'load' | 'networkidle')
        : 'domcontentloaded';

      await page.goto(parsedUrl.href, {
        waitUntil: validWaitUntil,
        timeout: parseInt(process.env['BROWSER_TIMEOUT_MS'] ?? '30000', 10),
      });

      const htmlContent = await page.content();

      reply.raw.writeHead(200, {
        'Content-Type':     'text/plain; charset=utf-8',
        'Transfer-Encoding':'chunked',
        'Cache-Control':    'no-store',
        'X-Proxy-Version':  '1.0',
      });

      const pruner = new SemanticPrunerStream();

      // Feed HTML in 64 KB chunks through the O(1) streaming pruner
      const CHUNK = 65_536;
      const source = new Readable({
        read() {
          let off = 0;
          while (off < htmlContent.length) {
            this.push(htmlContent.slice(off, off + CHUNK));
            off += CHUNK;
          }
          this.push(null);
        },
      });

      await pipeline(source, pruner, reply.raw);

      const stats = pruner.getStats();
      totalTokens += stats.tokensEmitted;
      console.log(
        `[browse] ${parsedUrl.hostname} | ` +
        `${stats.bytesIn} bytes → ${stats.tokensEmitted} tokens (${stats.compressionRatio})`,
      );

      await page.close();
      browserPool.release(bundle);
    } catch (err: any) {
      totalErrors++;
      console.error(`[browse] ${parsedUrl.hostname} error: ${err.message}`);
      await page.close().catch(() => undefined);
      await browserPool.destroy(bundle);
      if (!reply.raw.headersSent) {
        reply.status(500).send({ error: err.message });
      }
    }
  },
);

// ── GET /v1/health ────────────────────────────────────────────────────────────

fastify.get('/v1/health', async (_req, reply) => {
  const pool = browserPool.getStats();
  const mem  = process.memoryUsage();
  return reply.send({
    status: 'ok',
    uptime:  Math.floor(process.uptime()),
    pool,
    memory: {
      rss_mb:        +(mem.rss        / 1_048_576).toFixed(1),
      heap_used_mb:  +(mem.heapUsed   / 1_048_576).toFixed(1),
      heap_total_mb: +(mem.heapTotal  / 1_048_576).toFixed(1),
    },
    requests: { total: totalRequests, errors: totalErrors, tokens: totalTokens },
  });
});

// ── GET /v1/metrics (Prometheus) ──────────────────────────────────────────────

fastify.get('/v1/metrics', async (_req, reply) => {
  const ps  = browserPool.getStats();
  const mem = process.memoryUsage();
  const out = [
    `# HELP proxy_browsers_active Active Chromium instances`,
    `# TYPE proxy_browsers_active gauge`,
    `proxy_browsers_active ${ps.active}`,
    `# HELP proxy_browsers_idle Idle Chromium instances`,
    `# TYPE proxy_browsers_idle gauge`,
    `proxy_browsers_idle ${ps.idle}`,
    `# HELP proxy_requests_total Total requests`,
    `# TYPE proxy_requests_total counter`,
    `proxy_requests_total ${totalRequests}`,
    `# HELP proxy_errors_total Total errors`,
    `# TYPE proxy_errors_total counter`,
    `proxy_errors_total ${totalErrors}`,
    `# HELP proxy_tokens_total Semantic tokens emitted`,
    `# TYPE proxy_tokens_total counter`,
    `proxy_tokens_total ${totalTokens}`,
    `# HELP process_heap_used_bytes Node.js heap`,
    `# TYPE process_heap_used_bytes gauge`,
    `process_heap_used_bytes ${mem.heapUsed}`,
  ].join('\n') + '\n';
  reply.header('Content-Type', 'text/plain; version=0.0.4');
  return reply.send(out);
});

// ── Credential Vault ──────────────────────────────────────────────────────────

fastify.post<{ Body: { service?: string; apiKey?: string } }>(
  '/v1/credentials',
  async (request, reply) => {
    const { service, apiKey } = request.body ?? {};
    if (!service || !apiKey) {
      return reply.status(400).send({ error: '"service" and "apiKey" are required' });
    }
    try {
      await upsertCredential(service, apiKey);
      return reply.status(201).send({ stored: service });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  },
);

fastify.get('/v1/credentials', async (_req, reply) => {
  try {
    return reply.send({ services: await listServices() });
  } catch (e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

fastify.get<{ Params: { service: string } }>(
  '/v1/credentials/:service',
  async (request, reply) => {
    try {
      const key = await getCredential(request.params.service);
      if (!key) return reply.status(404).send({ error: 'Not found' });
      return reply.send({ service: request.params.service, apiKey: key });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  },
);

fastify.delete<{ Params: { service: string } }>(
  '/v1/credentials/:service',
  async (request, reply) => {
    try {
      return reply.send({ deleted: await deleteCredential(request.params.service) });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  },
);

// ── Startup ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await fastify.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await bootstrapSchema().catch((e) =>
    console.warn('[startup] DB schema skipped (no Postgres):', e.message),
  );

  browserPool.startStatsEmitter(5000);  // internal only — no WS clients

  const port = parseInt(process.env['PORT'] ?? '8080', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await fastify.listen({ port, host });

  const ps = browserPool.getStats();
  console.log(`
╔══════════════════════════════════════════════════╗
║  ChronoProxy  ready on http://${host}:${port}
╠══════════════════════════════════════════════════╣
║  POST /v1/browse          ← main endpoint
║  GET  /v1/health          ← liveness probe
║  GET  /v1/metrics         ← prometheus
║  POST /v1/credentials     ← store API keys
╠══════════════════════════════════════════════════╣
║  Pool : ${ps.maxBrowsers} browsers · RAM ceiling ~512 MB
╚══════════════════════════════════════════════════╝
`);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[shutdown] ${signal} — draining pool...`);
  await fastify.close();
  await browserPool.drain();
  await closeRedis();
  await closeDb();
  console.log('[shutdown] clean exit');
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (err) => {
  console.error('[error] uncaught exception:', err.message);
});

start().catch((err) => {
  console.error('[fatal] startup failed:', err);
  process.exit(1);
});
