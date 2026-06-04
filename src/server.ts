/**
 * server.ts — Fastify HTTP Server & Route Controller
 *
 * Endpoints:
 *   GET  /                  — Live monitoring dashboard (static)
 *   POST /v1/browse         — Main proxy: stream semantic tokens for a URL
 *   GET  /v1/health         — Liveness + pool + memory stats (JSON)
 *   GET  /v1/metrics        — Prometheus text format metrics
 *   POST /v1/credentials    — Store encrypted API credential
 *   GET  /v1/credentials    — List registered service names
 *   DEL  /v1/credentials/:service — Remove a credential
 *   WS   /ws/stats          — Real-time pool stats → dashboard
 */

import 'dotenv/config';
import path from 'path';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { browserPool, PoolStats } from './pool';
import { SemanticPrunerStream } from './pruner';
import { rateLimitHook, closeRedis } from './ratelimit';
import { bootstrapSchema, upsertCredential, getCredential, deleteCredential, listServices, closeDb } from './db';


// ── Server Initialization ─────────────────────────────────────────────────────

const fastify = Fastify({
  logger: false,
  trustProxy: true,         // X-Forwarded-For support
  bodyLimit: 1_048_576,     // 1MB max body (URLs are tiny)
  connectionTimeout: 30_000,
  keepAliveTimeout: 5_000,
});

// ── Request Telemetry ─────────────────────────────────────────────────────────

let totalRequests = 0;
let totalErrors   = 0;
let totalTokens   = 0;

// ── Route: POST /v1/browse ────────────────────────────────────────────────────

fastify.post<{ Body: { url?: string; waitUntil?: string } }>(
  '/v1/browse',
  { preHandler: rateLimitHook },
  async (request, reply) => {
    const { url, waitUntil = 'domcontentloaded' } = request.body ?? {};

    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'Body field "url" is required' });
    }

    // Validate URL shape before spinning up a browser
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
    let bundle = await browserPool.acquire().catch((err) => {
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
        timeout: parseInt(process.env['BROWSER_TIMEOUT_MS'] ?? '15000', 10),
      });

      const htmlContent = await page.content();

      // ── Stream Setup ────────────────────────────────────────────────────────
      // We create a Readable from the HTML string and pipe it through the pruner.
      // Even though page.content() is a string (not a true network stream), this
      // ensures the pruner's O(1) chunked model is exercised and the response
      // is sent incrementally to the client.

      reply.raw.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Proxy-Version': '1.0',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-store',
      });

      const pruner = new SemanticPrunerStream();

      // Feed the HTML string in 64KB chunks (simulates true network streaming)
      const CHUNK_SIZE = 65_536;
      const htmlReadable = new Readable({
        read() {
          let offset = 0;
          while (offset < htmlContent.length) {
            this.push(htmlContent.slice(offset, offset + CHUNK_SIZE));
            offset += CHUNK_SIZE;
          }
          this.push(null);
        },
      });

      // pipeline() handles backpressure and cleans up on error automatically
      await pipeline(htmlReadable, pruner, reply.raw);

      const stats = pruner.getStats();
      totalTokens += stats.tokensEmitted;
      console.log(
        `[browse] ${parsedUrl.hostname} | ` +
        `${stats.bytesIn} bytes → ${stats.tokensEmitted} tokens ` +
        `(${stats.compressionRatio} of original)`,
      );

      // Return browser to pool (healthy)
      await page.close();
      browserPool.release(bundle);
    } catch (err: any) {
      totalErrors++;
      console.error(`[browse] Error processing ${parsedUrl.hostname}: ${err.message}`);
      await page.close().catch(() => undefined);
      // Destroy the bundle — Chromium may be in a bad state after a navigation error
      await browserPool.destroy(bundle);
      // Reply may already be committed (headers sent), so only send if not started
      if (!reply.raw.headersSent) {
        reply.status(500).send({ error: err.message });
      }
    }
  },
);

// ── Route: GET /v1/health ─────────────────────────────────────────────────────

fastify.get('/v1/health', async (_req, reply) => {
  const poolStats = browserPool.getStats();
  const memUsage  = process.memoryUsage();
  return reply.send({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    pool: poolStats,
    memory: {
      rss_mb:      (memUsage.rss          / 1_048_576).toFixed(1),
      heap_used_mb:(memUsage.heapUsed     / 1_048_576).toFixed(1),
      heap_total_mb:(memUsage.heapTotal   / 1_048_576).toFixed(1),
      external_mb: (memUsage.external     / 1_048_576).toFixed(1),
    },
    requests: { total: totalRequests, errors: totalErrors, tokens: totalTokens },
  });
});

// ── Route: GET /v1/metrics (Prometheus) ───────────────────────────────────────

fastify.get('/v1/metrics', async (_req, reply) => {
  const ps  = browserPool.getStats();
  const mem = process.memoryUsage();
  const lines = [
    '# HELP proxy_browsers_active Active Chromium instances',
    '# TYPE proxy_browsers_active gauge',
    `proxy_browsers_active ${ps.active}`,
    '# HELP proxy_browsers_idle Idle Chromium instances in pool',
    '# TYPE proxy_browsers_idle gauge',
    `proxy_browsers_idle ${ps.idle}`,
    '# HELP proxy_requests_queued Requests waiting for a browser slot',
    '# TYPE proxy_requests_queued gauge',
    `proxy_requests_queued ${ps.queued}`,
    '# HELP proxy_estimated_memory_mb Estimated total RAM usage MB',
    '# TYPE proxy_estimated_memory_mb gauge',
    `proxy_estimated_memory_mb ${ps.estimatedMemoryMB}`,
    '# HELP proxy_requests_total Total HTTP requests processed',
    '# TYPE proxy_requests_total counter',
    `proxy_requests_total ${totalRequests}`,
    '# HELP proxy_errors_total Total errors',
    '# TYPE proxy_errors_total counter',
    `proxy_errors_total ${totalErrors}`,
    '# HELP proxy_tokens_total Total semantic tokens emitted',
    '# TYPE proxy_tokens_total counter',
    `proxy_tokens_total ${totalTokens}`,
    '# HELP process_heap_used_bytes Node.js heap used',
    '# TYPE process_heap_used_bytes gauge',
    `process_heap_used_bytes ${mem.heapUsed}`,
  ];
  reply.header('Content-Type', 'text/plain; version=0.0.4');
  return reply.send(lines.join('\n') + '\n');
});

// ── Route: Credential Vault ───────────────────────────────────────────────────

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
    const services = await listServices();
    return reply.send({ services });
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
      const deleted = await deleteCredential(request.params.service);
      return reply.send({ deleted });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  },
);

// ── Route: WebSocket /ws/stats ────────────────────────────────────────────────

fastify.get('/ws/stats', { websocket: true }, (socket) => {
  // @fastify/websocket v3 exposes the raw `ws` instance as socket.socket.
  // socket itself is the Duplex stream — readyState / send live one level down.
  const ws = (socket as any).socket ?? socket;

  const sendStats = (stats: PoolStats) => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          ...stats,
          nodeMemMB: (process.memoryUsage().rss / 1_048_576).toFixed(1),
          uptime:    Math.floor(process.uptime()),
          totalRequests,
          totalErrors,
          totalTokens,
          ts: Date.now(),
        }));
      }
    } catch {
      // Client disconnected mid-send — remove listener silently
      browserPool.off('stats', sendStats);
    }
  };

  browserPool.on('stats', sendStats);
  sendStats(browserPool.getStats()); // immediate snapshot on connect

  ws.on('close', () => browserPool.off('stats', sendStats));
  ws.on('error', () => browserPool.off('stats', sendStats));
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // ── Plugin registration (order matters) ────────────────────────────────────

  // CORS — allow browser requests from any origin (needed for dashboard)
  await fastify.register(fastifyCors, {
    origin: true,               // reflect the request origin
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Static files — serve the dashboard/ folder at GET /
  const dashboardDir = path.join(process.cwd(), 'dashboard');
  await fastify.register(fastifyStatic, {
    root:   dashboardDir,
    prefix: '/',
    decorateReply: true,
  });

  // WebSocket support
  await fastify.register(fastifyWebsocket);

  // ── Startup tasks ──────────────────────────────────────────────────────────
  await bootstrapSchema().catch((e) => {
    console.warn('[startup] DB schema bootstrap skipped:', e.message);
  });

  browserPool.startStatsEmitter(1000);

  const port = parseInt(process.env['PORT'] ?? '3001', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  const poolStats = browserPool.getStats();
  await fastify.listen({ port, host });
  console.log(`\n🚀 Semantic Browser Proxy  →  http://${host}:${port}`);
  console.log(`   📊 Dashboard             →  http://${host}:${port}/`);
  console.log(`   ❤️  Health               →  http://${host}:${port}/v1/health`);
  console.log(`   📈 Metrics (Prometheus)  →  http://${host}:${port}/v1/metrics`);
  console.log(`   🔌 WS stats feed         →  ws://${host}:${port}/ws/stats`);
  console.log(`   🔒 Pool ceiling          →  ${poolStats.maxBrowsers} browsers · 512 MB\n`);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[shutdown] Received ${signal}. Draining pool and closing connections...`);
  await fastify.close();
  await browserPool.drain();
  await closeRedis();
  await closeDb();
  console.log('[shutdown] Clean exit.');
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (err) => {
  console.error('[error] Uncaught exception (recovered):', err);
});

start().catch((err) => {
  console.error('[fatal] Startup failed:', err);
  process.exit(1);
});
