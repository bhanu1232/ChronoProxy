/**
 * test.mjs — ChronoProxy v2 Integration Test Suite
 *
 * Covers all endpoints:
 *   1. Health check
 *   2. POST /v1/extract   — structured page state from google.com
 *   3. POST /v1/session   — create AI agent session
 *   4. POST /v1/session/:id/action — type search query + press Enter
 *   5. GET  /v1/session/:id — read results page
 *   6. DELETE /v1/session/:id — close session
 *   7. POST /v1/browse    — legacy semantic token stream
 *
 * Usage:
 *   node test.mjs                       # default: localhost:3333
 *   BASE_URL=http://localhost:8080 node test.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3333';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';

let passed = 0, failed = 0;

function pass(msg) { console.log(`  ${G}✔${X}  ${msg}`); passed++; }
function fail(msg) { console.log(`  ${R}✖${X}  ${msg}`); failed++; }
function info(msg) { console.log(`  ${C}ℹ${X}  ${msg}`); }
function section(title) { console.log(`\n${B}${title}${X}`); }

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const ct  = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, ok: res.ok };
}

console.log(`\n${B}╔══════════════════════════════════════════════╗`);
console.log(`║  ChronoProxy v2 — Integration Test Suite    ║`);
console.log(`╚══════════════════════════════════════════════╝${X}`);
info(`Target: ${C}${BASE}${X}\n`);

// ── 1. Health ──────────────────────────────────────────────────────────────────
section('[1/7] GET /v1/health');
const health = await req('GET', '/v1/health');
if (health.data.status === 'ok') pass(`status=ok, uptime=${health.data.uptime}s, version=${health.data.version}`);
else fail(`Health failed: ${JSON.stringify(health.data)}`);
info(`pool: ${health.data.pool?.maxBrowsers} browsers  |  sessions: max ${health.data.sessions?.max}`);
info(`memory rss: ${health.data.memory?.rss_mb} MB`);

// ── 2. Extract (one-shot structured) ──────────────────────────────────────────
section('[2/7] POST /v1/extract → google.com');
info('navigating + extracting page state...');
const t2 = Date.now();
const ext = await req('POST', '/v1/extract', { url: 'https://google.com' });
if (ext.ok) {
  pass(`HTTP 200 in ${Date.now()-t2}ms`);
  pass(`title = "${ext.data.title}"`);
  pass(`${ext.data.headings?.length} headings  |  ${ext.data.links?.length} links  |  ${ext.data.inputs?.length} inputs  |  ${ext.data.buttons?.length} buttons`);
  info(`text snippet: "${ext.data.text?.slice(0, 120)}..."`);
  // Show the search input so AI agent knows the selector
  const searchInput = ext.data.inputs?.[0];
  if (searchInput) {
    pass(`found input: name="${searchInput.name}", selector="${searchInput.selector}"`);
  }
} else {
  fail(`Extract failed: ${JSON.stringify(ext.data)}`);
}

// ── 3. Create session ──────────────────────────────────────────────────────────
section('[3/7] POST /v1/session → open google.com');
info('creating persistent AI agent session...');
const t3 = Date.now();
const created = await req('POST', '/v1/session', { url: 'https://google.com' });
let sessionId = null;

if (created.status === 201) {
  sessionId = created.data.sessionId;
  pass(`session created: ${sessionId}  (${Date.now()-t3}ms)`);
  pass(`page URL: ${created.data.state?.url}`);
  const inp = created.data.state?.inputs?.[0];
  if (inp) info(`found input selector: ${inp.selector}`);
} else {
  fail(`Session create failed: ${JSON.stringify(created.data)}`);
}

// ── 4. Perform actions — search for "playwright" ───────────────────────────────
if (sessionId) {
  section('[4/7] POST /v1/session/:id/action — type + search');
  info('sending actions: fill search box → press Enter → wait for results...');
  const t4 = Date.now();

  // Get the search input selector from the page state
  const searchSelector = created.data.state?.inputs?.[0]?.selector ?? 'textarea[name="q"]';

  const actionRes = await req('POST', `/v1/session/${sessionId}/action`, {
    actions: [
      { type: 'fill',     selector: searchSelector, value: 'playwright browser automation' },
      { type: 'press',    key: 'Enter' },
      { type: 'wait_for', selector: 'h3', timeout: 8000 },
    ],
  });

  if (actionRes.ok) {
    const results = actionRes.data.results ?? [];
    const allOk   = results.every(r => r.ok);
    if (allOk) pass(`all ${results.length} actions succeeded  (${Date.now()-t4}ms)`);
    else fail(`action failed: ${JSON.stringify(results.find(r => !r.ok))}`);
    results.forEach(r => info(`  ${r.type}: ${r.durationMs}ms ${r.ok ? '✓' : '✗ ' + r.error}`));
    pass(`now on: ${actionRes.data.state?.url}`);
    const firstH3 = actionRes.data.state?.headings?.find(h => h.level === 'h3');
    if (firstH3) pass(`first result heading: "${firstH3.text}"`);
  } else {
    fail(`Action failed: ${JSON.stringify(actionRes.data)}`);
  }

  // ── 5. Read current page state ─────────────────────────────────────────────
  section('[5/7] GET /v1/session/:id — read results page');
  const t5 = Date.now();
  const snap = await req('GET', `/v1/session/${sessionId}`);
  if (snap.ok) {
    pass(`HTTP 200  (${Date.now()-t5}ms)`);
    pass(`${snap.data.state?.links?.length} links on results page`);
    pass(`${snap.data.state?.headings?.length} headings`);
    info(`text snippet: "${snap.data.state?.text?.slice(0, 200)}..."`);
  } else {
    fail(`Get session failed: ${JSON.stringify(snap.data)}`);
  }

  // ── 6. Delete session ──────────────────────────────────────────────────────
  section('[6/7] DELETE /v1/session/:id — close session');
  const del = await req('DELETE', `/v1/session/${sessionId}`);
  if (del.ok && del.data.ok) pass(`session ${sessionId} destroyed`);
  else fail(`Delete failed: ${JSON.stringify(del.data)}`);

  // Verify it's gone
  const gone = await req('GET', `/v1/session/${sessionId}`);
  if (gone.status === 404) pass('session correctly returns 404 after deletion');
  else fail(`Expected 404, got ${gone.status}`);
}

// ── 7. Legacy browse stream ────────────────────────────────────────────────────
section('[7/7] POST /v1/browse — semantic token stream');
info('streaming google.com through pruner...');
const t7  = Date.now();
const res7 = await fetch(`${BASE}/v1/browse`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com' }),
});
let body = '', chunks = 0;
for await (const chunk of res7.body) { body += new TextDecoder().decode(chunk, { stream: true }); chunks++; }
const tokens = body.trim().split(/\s+/).filter(Boolean);
if (res7.ok && tokens.length > 0) {
  pass(`HTTP 200 — ${chunks} chunks · ${tokens.length} tokens · ${Date.now()-t7}ms`);
} else {
  fail(`Browse failed: ${res7.status}`);
}

// ── Final health snapshot ──────────────────────────────────────────────────────
const h2 = await req('GET', '/v1/health');
console.log(`\n${B}Final Stats${X}`);
info(`requests: ${h2.data.requests?.total}  errors: ${h2.data.requests?.errors}  tokens: ${h2.data.requests?.tokens}`);
info(`active sessions: ${h2.data.sessions?.active}`);
info(`memory rss: ${h2.data.memory?.rss_mb} MB`);

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${B}╔══════════════════════════════════════════════╗`);
console.log(`║  Results: ${G}${passed} passed${X}${B}  ${failed > 0 ? R : G}${failed} failed${X}${B}             ║`);
console.log(`╚══════════════════════════════════════════════╝${X}\n`);
if (failed > 0) process.exit(1);
