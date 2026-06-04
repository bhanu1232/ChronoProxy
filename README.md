# 🔭 Semantic Browser Proxy

> **Production-ready, memory-constrained headless web scraping proxy.**  
> Hard ceiling: **512 MB RAM** · Architecture: **Event-Driven I/O + O(1) Stream Parsing**

---

## Architecture

```
AI Agent → POST /v1/browse → Fastify → BrowserPool → Playwright → SemanticPrunerStream → SSE Response
                                  ↕                                           ↕
                               Redis (rate-limit)              htmlparser2 (64KB chunks)
                                  ↕
                            PostgreSQL (encrypted credential vault)
```

| Component | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 + TypeScript | V8 event loop, ~30MB base RAM |
| HTTP Server | Fastify | 35k req/s, zero-overhead plugins |
| Browser | Playwright Chromium | Stable, scriptable, flag-controlled |
| HTML Parser | htmlparser2 | SAX-style streaming, O(1) space |
| Rate Limiter | Redis + Lua sliding window | Atomic, sub-millisecond |
| Credential Vault | PostgreSQL + AES-256-GCM | Encrypted at rest |

## Quick Start

```bash
# 1. Copy env file and fill in your values
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Start the proxy (requires Redis + Postgres, or skip for dashboard-only)
npm run dev

# 4. Open the live simulation dashboard (no server needed)
open dashboard/index.html
# or: npx http-server dashboard -p 3000
```

### Docker (full stack)

```bash
cd docker
docker compose up -d
```

Services: proxy on `:8080`, Redis on `:6379`, Postgres on `:5432`

---

## API Reference

### `POST /v1/browse`

Stream semantic tokens for a URL.

```bash
curl -X POST http://localhost:8080/v1/browse \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://github.com", "waitUntil": "domcontentloaded"}'
```

**Response** (`text/plain`, streaming):
```
[#0] <a href="/login">Sign in</a>
[#1] <input type="text" placeholder="Search or jump to..." aria-label="Search GitHub"></input>
[#2] <button type="submit">Search</button>
...
```

### `GET /v1/health`

```json
{
  "status": "ok",
  "pool": { "active": 2, "idle": 2, "queued": 0, "estimatedMemoryMB": 270 },
  "memory": { "rss_mb": "142.3", "heap_used_mb": "38.1" },
  "requests": { "total": 1420, "errors": 3, "tokens": 284000 }
}
```

### `GET /v1/metrics`

Prometheus text format — scrape at `/v1/metrics`.

### `WS /ws/stats`

Real-time JSON stats feed for the dashboard. Emits every 1 second:
```json
{ "active": 2, "idle": 2, "queued": 0, "estimatedMemoryMB": 270, "totalTokens": 5820, "ts": 1716000000000 }
```

---

## Memory Model

| Component | RAM |
|---|---|
| Node.js process (base) | ~80 MB |
| Per Chromium instance | ~95 MB |
| Redis client | ~5 MB |
| Postgres pool (5 conns) | ~10 MB |
| **Max @ 4 browsers** | **~475 MB** |
| **Ceiling** | **512 MB** |

The pruner itself uses **O(1)** space: only one element's data lives in memory at any time.  
A 10 MB HTML page produces ~1–5 KB of semantic tokens (>99% compression ratio).

---

## SemanticPrunerStream

The heart of the system. Extends `Transform` stream:

1. Receives HTML in **64 KB chunks**
2. `htmlparser2` fires `onopentag` / `ontext` / `onclosetag` events
3. Only interactive elements are captured: `<a>`, `<button>`, `<input>`, `<select>`, `<textarea>`, `role="button"`
4. On `onclosetag`, the token is **pushed downstream** and the buffer **reset to `""`**
5. GC can collect the 256-byte token string immediately

```
10 MB HTML → 64 KB chunks → 156 parse cycles → ~200 tokens (~16 KB)
Peak heap pressure: 64 KB chunk + 256 bytes token buffer
```

---

## Simulation Dashboard

Open `dashboard/index.html` in any browser. No server required.

**Controls:**
- **λ slider** — arrival rate (req/s). Move right to simulate traffic spikes.
- **Pool slider** — browser pool size. Decrease to force queue buildup.
- **Service Time** — average processing time per request.
- **Rate Limiting toggle** — simulate Redis being enabled/disabled.
- **Inject Spike** — fires 25–45 simultaneous arrivals.
- **Pause / Reset** — control simulation state.

**Panels:**
- **Concurrency Timeline** — canvas graph: active browsers (cyan) + queue depth (amber) vs. pool ceiling (red dashed)
- **Memory Gauge** — radial gauge with green/amber/red safety zones
- **Request Queue** — live list of in-flight requests with state badges
- **Event Log** — tail of last 30 system events
- **Little's Law** — L, W, ρ, and total tokens

---

## Security Notes

- API keys are encrypted with **AES-256-GCM** before writing to Postgres.
- The encryption key is loaded from `ENCRYPTION_KEY` env var (never stored).
- Rate limiting uses a **sliding window Lua script** in Redis (atomic, no races).
- The Chromium process runs with `--no-sandbox` only when inside a container; for production on bare metal, drop that flag and use a proper user namespace.

---

## File Map

```
src/
  browser.ts    — Lean Chromium launcher (20+ resource-kill flags)
  pruner.ts     — O(1) semantic stream parser
  pool.ts       — Fixed-size browser concurrency pool
  ratelimit.ts  — Redis sliding-window rate limiter
  db.ts         — AES-256-GCM credential vault
  server.ts     — Fastify HTTP server (8 routes + WebSocket)
dashboard/
  index.html    — Interactive simulation dashboard
  simulation.js — Discrete-event M/M/c/K queue simulation engine
  style.css     — Dark glassmorphism design system
docker/
  Dockerfile         — Multi-stage build
  docker-compose.yml — Full service mesh
```
"# ChronoProxy" 
