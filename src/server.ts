/**
 * server.ts — ChronoProxy v2 API Server
 *
 * Purpose: Give AI agents direct access to browser content and actions
 * WITHOUT screenshots. Eliminates vision-model token usage for browser tasks.
 *
 * ─── Endpoints ────────────────────────────────────────────────────────────────
 *
 *  One-shot (stateless)
 *  POST /v1/browse          Stream semantic tokens from a URL (text/plain)
 *  POST /v1/extract         Fetch URL → return full structured PageState (JSON)
 *
 *  Sessions (stateful — AI agent workflow)
 *  POST   /v1/session              Create session, navigate to URL
 *  GET    /v1/session/:id          Get current page state
 *  POST   /v1/session/:id/action   Perform actions, return new page state
 *  DELETE /v1/session/:id          Close session
 *
 *  Observability
 *  GET  /v1/health          Liveness + pool + session stats (JSON)
 *  GET  /v1/metrics         Prometheus text-format metrics
 *
 *  Credential Vault (optional)
 *  POST   /v1/credentials
 *  GET    /v1/credentials
 *  GET    /v1/credentials/:service
 *  DELETE /v1/credentials/:service
 */

import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { browserPool } from './pool';
import { SemanticPrunerStream } from './pruner';
import { rateLimitHook, closeRedis } from './ratelimit';
import { extractPageState } from './extractor';
import { executeActions, executeActionsStreaming, Action } from './actions';
import { sessionManager } from './session';
import {
  bootstrapSchema, upsertCredential, getCredential,
  deleteCredential, listServices, closeDb,
} from './db';

// ── Server ────────────────────────────────────────────────────────────────────

const fastify = Fastify({
  logger:            false,
  trustProxy:        true,
  bodyLimit:         2_097_152,   // 2 MB (action arrays can be larger)
  connectionTimeout: 60_000,
  keepAliveTimeout:  5_000,
});

// ── Telemetry ─────────────────────────────────────────────────────────────────

let totalRequests = 0;
let totalErrors   = 0;
let totalTokens   = 0;

// ── GET / — API index ─────────────────────────────────────────────────────────

fastify.get('/', async (_req, reply) => {
  return reply.send({
    name:        'ChronoProxy',
    version:     '2.0.0',
    description: 'AI agent browser API — structured page data + actions, no screenshots needed',
    endpoints: {
      // One-shot
      browse:          'POST /v1/browse           { url }           → stream semantic tokens',
      extract:         'POST /v1/extract          { url }           → JSON PageState',
      // Sessions
      createSession:   'POST /v1/session          { url }           → { sessionId, state }',
      getSession:      'GET  /v1/session/:id                        → { state }',
      runActions:      'POST /v1/session/:id/action        { actions: [] } → { results, state }',
      runActionsStream:'POST /v1/session/:id/action/stream { actions: [] } → SSE stream of ActionResult events',
      closeSession:    'DELETE /v1/session/:id                             → { ok }',
      // Observability
      health:          'GET  /v1/health',
      metrics:         'GET  /v1/metrics',
    },
    actionTypes: [
      'navigate', 'click', 'click_text', 'type', 'fill',
      'press', 'scroll', 'scroll_to', 'select', 'hover',
      'wait_for', 'wait', 'clear',
    ],
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ONE-SHOT ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /v1/browse — stream semantic tokens ──────────────────────────────────

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
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Only http/https');
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
      const vw = ['commit','domcontentloaded','load','networkidle'].includes(waitUntil)
        ? (waitUntil as any) : 'domcontentloaded';
      await page.goto(parsedUrl.href, {
        waitUntil: vw,
        timeout: parseInt(process.env['BROWSER_TIMEOUT_MS'] ?? '30000', 10),
      });

      const html = await page.content();

      reply.raw.writeHead(200, {
        'Content-Type':      'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control':     'no-store',
        'X-Proxy-Version':   '2.0',
      });

      const pruner = new SemanticPrunerStream();
      const source = new Readable({
        read() {
          let off = 0;
          while (off < html.length) { this.push(html.slice(off, off + 65536)); off += 65536; }
          this.push(null);
        },
      });
      await pipeline(source, pruner, reply.raw);

      const stats = pruner.getStats();
      totalTokens += stats.tokensEmitted;
      console.log(`[browse] ${parsedUrl.hostname} | ${stats.bytesIn}B → ${stats.tokensEmitted} tokens (${stats.compressionRatio})`);
      await page.close();
      browserPool.release(bundle);
    } catch (err: any) {
      totalErrors++;
      console.error(`[browse] ${parsedUrl.hostname} error: ${err.message}`);
      await page.close().catch(() => undefined);
      await browserPool.destroy(bundle);
      if (!reply.raw.headersSent) reply.status(500).send({ error: err.message });
    }
  },
);

// ── POST /v1/extract — one-shot structured page state ────────────────────────

fastify.post<{ Body: { url?: string; waitUntil?: string } }>(
  '/v1/extract',
  { preHandler: rateLimitHook },
  async (request, reply) => {
    const { url, waitUntil = 'domcontentloaded' } = request.body ?? {};

    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'Body field "url" is required' });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Only http/https');
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
      const vw = ['commit','domcontentloaded','load','networkidle'].includes(waitUntil)
        ? (waitUntil as any) : 'domcontentloaded';
      await page.goto(parsedUrl.href, {
        waitUntil: vw,
        timeout: parseInt(process.env['BROWSER_TIMEOUT_MS'] ?? '30000', 10),
      });

      const state = await extractPageState(page);
      totalTokens += state.text.split(/\s+/).length;
      console.log(`[extract] ${parsedUrl.hostname} | ${state.links.length} links, ${state.inputs.length} inputs, ${state.buttons.length} buttons`);
      await page.close();
      browserPool.release(bundle);
      return reply.send(state);
    } catch (err: any) {
      totalErrors++;
      console.error(`[extract] ${parsedUrl.hostname} error: ${err.message}`);
      await page.close().catch(() => undefined);
      await browserPool.destroy(bundle);
      return reply.status(500).send({ error: err.message });
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
//  SESSION ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /v1/session — create session ────────────────────────────────────────

fastify.post<{ Body: { url?: string; waitUntil?: string } }>(
  '/v1/session',
  { preHandler: rateLimitHook },
  async (request, reply) => {
    const { url, waitUntil = 'domcontentloaded' } = request.body ?? {};

    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'Body field "url" is required' });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Only http/https');
    } catch (e: any) {
      return reply.status(400).send({ error: `Invalid URL: ${e.message}` });
    }

    try {
      const vw = ['commit','domcontentloaded','load','networkidle'].includes(waitUntil)
        ? (waitUntil as any) : 'domcontentloaded';
      const session = await sessionManager.create(parsedUrl.href, vw);
      const state   = await extractPageState(session.page);
      sessionManager.touch(session.id);
      totalRequests++;
      console.log(`[session:create] ${session.id} → ${parsedUrl.hostname}`);
      return reply.status(201).send({ sessionId: session.id, state });
    } catch (err: any) {
      totalErrors++;
      const code = err.message.includes('Session limit') ? 429 : 500;
      return reply.status(code).send({ error: err.message });
    }
  },
);

// ── GET /v1/session/:id — get current page state ──────────────────────────────

fastify.get<{ Params: { id: string } }>(
  '/v1/session/:id',
  async (request, reply) => {
    try {
      const session = sessionManager.get(request.params.id);
      const state   = await extractPageState(session.page);
      sessionManager.touch(session.id);
      return reply.send({ sessionId: session.id, state });
    } catch (err: any) {
      const code = err.message.includes('not found') || err.message.includes('expired') ? 404 : 500;
      return reply.status(code).send({ error: err.message });
    }
  },
);

// ── POST /v1/session/:id/action — perform actions ─────────────────────────────

fastify.post<{
  Params: { id: string };
  Body:   { actions?: Action[] };
}>(
  '/v1/session/:id/action',
  { preHandler: rateLimitHook },
  async (request, reply) => {
    const { actions } = request.body ?? {};

    if (!Array.isArray(actions) || actions.length === 0) {
      return reply.status(400).send({ error: 'Body field "actions" must be a non-empty array' });
    }
    if (actions.length > 50) {
      return reply.status(400).send({ error: 'Max 50 actions per request' });
    }

    let session;
    try {
      session = sessionManager.get(request.params.id);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }

    try {
      totalRequests++;
      const results = await executeActions(session.page, actions);
      const state   = await extractPageState(session.page);
      sessionManager.touch(session.id);

      const failed = results.find(r => !r.ok);
      console.log(`[session:action] ${session.id} | ${results.length} actions${failed ? ` FAILED at ${failed.type}: ${failed.error}` : ' OK'}`);

      return reply.send({ sessionId: session.id, results, state });
    } catch (err: any) {
      totalErrors++;
      console.error(`[session:action] ${session.id} error: ${err.message}`);
      return reply.status(500).send({ error: err.message });
    }
  },
);

// ── POST /v1/session/:id/action/stream — SSE real-time action telemetry ─────────
//
// Same semantics as /action but streams one Server-Sent Event per step:
//
//   event: action_result
//   data: {"step":1,"total":4,"type":"fill","ok":true,"durationMs":82}
//
//   event: action_result
//   data: {"step":2,"total":4,"type":"click","ok":false,"durationMs":15012,"error":"Timeout"}
//
//   event: done
//   data: {"completedSteps":2,"success":false,"state":{...}}
//
// The agent can process each step result immediately without waiting for
// the entire batch — enabling real-time retry and adaptive strategy.

fastify.post<{
  Params: { id: string };
  Body:   { actions?: Action[] };
}>(
  '/v1/session/:id/action/stream',
  { preHandler: rateLimitHook },
  async (request, reply) => {
    const { actions } = request.body ?? {};

    if (!Array.isArray(actions) || actions.length === 0) {
      return reply.status(400).send({ error: 'Body field "actions" must be a non-empty array' });
    }
    if (actions.length > 50) {
      return reply.status(400).send({ error: 'Max 50 actions per request' });
    }

    let session;
    try {
      session = sessionManager.get(request.params.id);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }

    // ── Set SSE headers ──────────────────────────────────────────────────────
    // We write headers manually so we can keep the connection open and stream
    // individual events as each action completes.
    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',           // Disable Nginx/proxy buffering
      'Access-Control-Allow-Origin': '*',
    });

    // Helper to write a single SSE event
    const sendEvent = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    totalRequests++;
    const results: Array<{ step: number; total: number; type: string; ok: boolean; durationMs: number; error?: string }> = [];
    let completedSteps = 0;
    let overallSuccess = true;

    try {
      for await (const result of executeActionsStreaming(session.page, actions)) {
        results.push(result);
        completedSteps = result.step;
        if (!result.ok) overallSuccess = false;

        // Push this step's result to the client immediately
        sendEvent('action_result', result);

        // If a step failed, the generator has already stopped — break is implicit
      }

      // Extract updated page state after all actions
      const state = await extractPageState(session.page);
      sessionManager.touch(session.id);

      const logSuffix = overallSuccess
        ? `${completedSteps} actions OK`
        : `FAILED at step ${completedSteps}: ${results.find(r => !r.ok)?.error ?? 'unknown'}`;
      console.log(`[session:action:stream] ${session.id} | ${logSuffix}`);

      // Final event: summary + new page state
      sendEvent('done', { completedSteps, totalSteps: actions.length, success: overallSuccess, state });
    } catch (err: any) {
      totalErrors++;
      console.error(`[session:action:stream] ${session.id} error: ${err.message}`);
      sendEvent('error', { message: err.message });
    } finally {
      reply.raw.end();
    }
    return reply;
  },
);

// ── DELETE /v1/session/:id — close session ────────────────────────────────────

fastify.delete<{ Params: { id: string } }>(
  '/v1/session/:id',
  async (request, reply) => {
    const ok = await sessionManager.destroy(request.params.id);
    if (!ok) return reply.status(404).send({ error: `Session not found: ${request.params.id}` });
    return reply.send({ ok: true, destroyed: request.params.id });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
//  OBSERVABILITY
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /v1/health ────────────────────────────────────────────────────────────

fastify.get('/v1/health', async (_req, reply) => {
  const pool = browserPool.getStats();
  const mem  = process.memoryUsage();
  return reply.send({
    status:   'ok',
    version:  '2.0.0',
    uptime:   Math.floor(process.uptime()),
    pool,
    sessions: {
      active: sessionManager.count,
      max:    parseInt(process.env['MAX_SESSIONS'] ?? '4', 10),
      list:   sessionManager.list(),
    },
    memory: {
      rss_mb:        +(mem.rss        / 1_048_576).toFixed(1),
      heap_used_mb:  +(mem.heapUsed   / 1_048_576).toFixed(1),
      heap_total_mb: +(mem.heapTotal  / 1_048_576).toFixed(1),
    },
    requests: { total: totalRequests, errors: totalErrors, tokens: totalTokens },
  });
});

// ── GET /v1/metrics ───────────────────────────────────────────────────────────

fastify.get('/v1/metrics', async (_req, reply) => {
  const ps  = browserPool.getStats();
  const mem = process.memoryUsage();
  const out = [
    `proxy_browsers_active ${ps.active}`,
    `proxy_browsers_idle ${ps.idle}`,
    `proxy_sessions_active ${sessionManager.count}`,
    `proxy_requests_total ${totalRequests}`,
    `proxy_errors_total ${totalErrors}`,
    `proxy_tokens_total ${totalTokens}`,
    `process_heap_used_bytes ${mem.heapUsed}`,
    `process_rss_bytes ${mem.rss}`,
  ].join('\n') + '\n';
  reply.header('Content-Type', 'text/plain; version=0.0.4');
  return reply.send(out);
});

// ═════════════════════════════════════════════════════════════════════════════
//  CREDENTIAL VAULT
// ═════════════════════════════════════════════════════════════════════════════

fastify.post<{ Body: { service?: string; apiKey?: string } }>(
  '/v1/credentials',
  async (request, reply) => {
    const { service, apiKey } = request.body ?? {};
    if (!service || !apiKey) return reply.status(400).send({ error: '"service" and "apiKey" are required' });
    try {
      await upsertCredential(service, apiKey);
      return reply.status(201).send({ stored: service });
    } catch (e: any) { return reply.status(500).send({ error: e.message }); }
  },
);

fastify.get('/v1/credentials', async (_req, reply) => {
  try { return reply.send({ services: await listServices() }); }
  catch (e: any) { return reply.status(500).send({ error: e.message }); }
});

fastify.get<{ Params: { service: string } }>('/v1/credentials/:service', async (request, reply) => {
  try {
    const key = await getCredential(request.params.service);
    if (!key) return reply.status(404).send({ error: 'Not found' });
    return reply.send({ service: request.params.service, apiKey: key });
  } catch (e: any) { return reply.status(500).send({ error: e.message }); }
});

fastify.delete<{ Params: { service: string } }>('/v1/credentials/:service', async (request, reply) => {
  try { return reply.send({ deleted: await deleteCredential(request.params.service) }); }
  catch (e: any) { return reply.status(500).send({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  STARTUP & SHUTDOWN
// ═════════════════════════════════════════════════════════════════════════════

async function start(): Promise<void> {
  await fastify.register(fastifyCors, {
    origin:         true,
    methods:        ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await bootstrapSchema().catch((e) =>
    console.warn('[startup] DB schema skipped (no Postgres):', e.message),
  );

  browserPool.startStatsEmitter(10_000);
  sessionManager.start();

  const port = parseInt(process.env['PORT'] ?? '8080', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await fastify.listen({ port, host });

  const ps = browserPool.getStats();
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  ChronoProxy v2.0  →  http://${host}:${port}
╠════════════════════════════════════════════════════════════╣
║  ONE-SHOT                                                  ║
║    POST /v1/browse          stream semantic tokens         ║
║    POST /v1/extract         structured JSON page state     ║
║                                                            ║
║  SESSIONS  (AI agent workflow)                             ║
║    POST   /v1/session        create + navigate             ║
║    GET    /v1/session/:id    read current page             ║
║    POST   /v1/session/:id/action        sync batch          ║
║    POST   /v1/session/:id/action/stream SSE real-time       ║
║    DELETE /v1/session/:id               close session       ║
║                                                            ║
║  OBSERVABILITY                                             ║
║    GET /v1/health  ·  GET /v1/metrics                      ║
╠════════════════════════════════════════════════════════════╣
║  Pool: ${ps.maxBrowsers} browsers · Sessions: max ${process.env['MAX_SESSIONS'] ?? 4} · RAM ≤ 512 MB
╚════════════════════════════════════════════════════════════╝
`);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[shutdown] ${signal} — draining...`);
  await fastify.close();
  await sessionManager.stop();
  await browserPool.drain();
  await closeRedis();
  await closeDb();
  console.log('[shutdown] clean exit');
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (err) => { console.error('[error] uncaught:', err.message); });

start().catch((err) => { console.error('[fatal]', err); process.exit(1); });
