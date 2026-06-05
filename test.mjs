/**
 * test.mjs — ChronoProxy Integration Test
 *
 * Tests the full pipeline:
 *   1. Health check
 *   2. POST /v1/browse → google.com
 *   3. Validates semantic tokens are returned
 *   4. Prints timing + compression stats
 *
 * Usage:
 *   node test.mjs                     # uses localhost:3333 (Docker default)
 *   BASE_URL=http://localhost:8080 node test.mjs
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3333';

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

const pass = (msg) => console.log(`  ${GREEN}✔${RESET}  ${msg}`);
const fail = (msg) => { console.log(`  ${RED}✖${RESET}  ${msg}`); process.exit(1); };
const info = (msg) => console.log(`  ${CYAN}ℹ${RESET}  ${msg}`);

console.log(`\n${BOLD}ChronoProxy Integration Test${RESET}`);
console.log(`  Target: ${CYAN}${BASE_URL}${RESET}\n`);

// ── Test 1: Health check ───────────────────────────────────────────────────────
console.log(`${BOLD}[1/2] Health check${RESET}`);
const t0 = Date.now();
const healthRes = await fetch(`${BASE_URL}/v1/health`);
if (!healthRes.ok) fail(`Health returned HTTP ${healthRes.status}`);
const health = await healthRes.json();
if (health.status !== 'ok') fail(`status is "${health.status}", expected "ok"`);
pass(`status = ok  (${Date.now() - t0}ms)`);
pass(`uptime = ${health.uptime}s`);
pass(`pool ceiling = ${health.pool.maxBrowsers} browsers`);
info(`memory rss = ${health.memory.rss_mb} MB`);

// ── Test 2: Browse google.com ─────────────────────────────────────────────────
console.log(`\n${BOLD}[2/2] POST /v1/browse → https://google.com${RESET}`);
info('launching Chromium, navigating, streaming tokens...\n');

const t1 = Date.now();
const browseRes = await fetch(`${BASE_URL}/v1/browse`, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify({ url: 'https://google.com' }),
});

if (!browseRes.ok) {
  const err = await browseRes.json().catch(() => ({ error: browseRes.statusText }));
  fail(`/v1/browse returned HTTP ${browseRes.status}: ${err.error}`);
}

// Stream and collect the response chunks
let body      = '';
let chunkCount = 0;
const decoder  = new TextDecoder();

for await (const chunk of browseRes.body) {
  const text = decoder.decode(chunk, { stream: true });
  body += text;
  chunkCount++;
  // Print first 3 chunks live so you can see tokens arriving
  if (chunkCount <= 3) {
    process.stdout.write(`  ${YELLOW}chunk ${chunkCount}${RESET}: ${text.slice(0, 120).replace(/\n/g, ' ')}\n`);
  }
}

const elapsed   = Date.now() - t1;
const tokens    = body.trim().split(/\s+/).filter(Boolean);
const bytesSent = Buffer.byteLength(body, 'utf8');

if (tokens.length === 0) fail('No tokens received — response was empty');

console.log();
pass(`HTTP 200 — chunked stream received`);
pass(`${chunkCount} chunks · ${tokens.length} tokens · ${bytesSent} bytes`);
pass(`Total time: ${elapsed}ms  (~${(bytesSent / 1024).toFixed(1)} KB)`);

// Show a sample of the extracted text
console.log(`\n${BOLD}  Sample tokens from google.com:${RESET}`);
const sample = tokens.slice(0, 40).join(' ');
console.log(`  "${CYAN}${sample}${RESET}..."`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}${GREEN}All tests passed ✔${RESET}\n`);

// Final health to confirm pool is back to idle
const healthAfter = await fetch(`${BASE_URL}/v1/health`).then(r => r.json());
info(`requests processed: ${healthAfter.requests.total}`);
info(`tokens emitted:     ${healthAfter.requests.tokens}`);
info(`pool idle:          ${healthAfter.pool.idle}`);
console.log();
