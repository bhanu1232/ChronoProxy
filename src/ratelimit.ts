/**
 * ratelimit.ts — Redis-Backed Sliding Window Rate Limiter
 *
 * Uses an ioredis client with a Lua script that implements a sliding-window
 * counter entirely server-side (atomic, no race conditions).
 *
 * Algorithm: each request increments a key scoped to (ip, floor(now/window)).
 * Complexity: O(1) time, O(1) space per IP per window.
 *
 * Integration: exported as a Fastify preHandler hook.
 */

import Redis from 'ioredis';
import { FastifyRequest, FastifyReply } from 'fastify';

// ── Redis Client ──────────────────────────────────────────────────────────────

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host:     process.env['REDIS_HOST']     ?? '127.0.0.1',
      port:     parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
      password: process.env['REDIS_PASSWORD'] || undefined,
      lazyConnect: true,
      enableOfflineQueue: false,  // Fail fast if Redis is down; fallback to no-limit
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // Don't auto-reconnect; fail-open on every attempt
    });
    redisClient.on('error', (err: Error) => {
      console.warn('[rate-limit] Redis error (falling back to no-limit):', err.message);
    });
  }
  return redisClient;
}

// ── Sliding-Window Lua Script ─────────────────────────────────────────────────
// KEYS[1] = rate-limit key (e.g. "rl:192.168.1.1:1716000000")
// ARGV[1] = window TTL in seconds
// ARGV[2] = max allowed requests per window
// Returns: { current_count, is_allowed }
const SLIDING_WINDOW_SCRIPT = `
local key    = KEYS[1]
local ttl    = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])
local count  = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, ttl)
end
local allowed = (count <= limit) and 1 or 0
return {count, allowed}
`;

// ── Configuration ─────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX_REQ  = parseInt(process.env['RATE_LIMIT_MAX']        ?? '30',    10);
const RATE_LIMIT_WINDOW   = parseInt(process.env['RATE_LIMIT_WINDOW_MS']  ?? '60000', 10); // ms

/** Extract the best available IP from a Fastify request */
function getClientIp(req: FastifyRequest): string {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined);
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip ?? '0.0.0.0';
}

/**
 * rateLimitHook — Fastify preHandler.
 *
 * Attach to any route:
 *   fastify.post('/v1/browse', { preHandler: rateLimitHook }, handler);
 *
 * On rate-limit breach: responds 429 with Retry-After header.
 * On Redis failure: logs a warning and allows the request (fail-open).
 */
export async function rateLimitHook(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ip     = getClientIp(req);
  const window = Math.floor(Date.now() / RATE_LIMIT_WINDOW);
  const key    = `rl:${ip}:${window}`;
  const ttlSec = Math.ceil(RATE_LIMIT_WINDOW / 1000);

  try {
    const redis = getRedis();
    const result = (await redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      ttlSec.toString(),
      RATE_LIMIT_MAX_REQ.toString(),
    )) as [number, number];

    const [count, allowed] = result;

    reply.header('X-RateLimit-Limit',     RATE_LIMIT_MAX_REQ.toString());
    reply.header('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX_REQ - count).toString());
    reply.header('X-RateLimit-Reset',     ((window + 1) * RATE_LIMIT_WINDOW / 1000).toFixed(0));

    if (!allowed) {
      reply.status(429).send({
        error: 'Rate limit exceeded',
        retryAfterSeconds: ttlSec,
        limit: RATE_LIMIT_MAX_REQ,
        window: `${RATE_LIMIT_WINDOW / 1000}s`,
      });
    }
  } catch {
    // Redis unavailable — fail-open (allow the request, log the issue)
    console.warn(`[rate-limit] Redis unavailable for key ${key}; allowing request`);
  }
}

/** Graceful shutdown helper */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => undefined);
    redisClient = null;
  }
}
