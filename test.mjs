/**
 * test.mjs — ChronoProxy v2 Integration Test Suite
 *
 * Covers all endpoints:
 *   1. Health check
 *   2. POST /v1/extract   — structured page state from google.com
 *   3. POST /v1/session   — create AI agent session
 *   4. POST /v1/session/:id/action        — sync batch (fill + submit)
 *   4b. POST /v1/session/:id/action/stream — SSE real-time stream
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
section('[1/8] GET /v1/health');
const health = await req('GET', '/v1/health');
if (health.data.status === 'ok') pass(`status=ok, uptime=${health.data.uptime}s, version=${health.data.version}`);
else fail(`Health failed: ${JSON.stringify(health.data)}`);
info(`pool: ${health.data.pool?.maxBrowsers} browsers  |  sessions: max ${health.data.sessions?.max}`);
info(`memory rss: ${health.data.memory?.rss_mb} MB`);

// ── 2. Extract (one-shot structured) ──────────────────────────────────────────
section('[2/8] POST /v1/extract → google.com');
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
section('[3/8] POST /v1/session → the-internet.herokuapp.com/login');
info('creating persistent AI agent session on a real login form...');
const t3 = Date.now();
const created = await req('POST', '/v1/session', { url: 'https://the-internet.herokuapp.com/login' });
let sessionId = null;

if (created.status === 201) {
  sessionId = created.data.sessionId;
  pass(`session created: ${sessionId}  (${Date.now()-t3}ms)`);
  pass(`page URL: ${created.data.state?.url}`);
  pass(`page title: "${created.data.state?.title}"`);
  const inputs = created.data.state?.inputs ?? [];
  inputs.forEach(i => info(`  input: name="${i.name}" type="${i.type}" selector="${i.selector}"`));
} else {
  fail(`Session create failed: ${JSON.stringify(created.data)}`);
}

// ── 4. Fill login form + submit ────────────────────────────────────────────────
if (sessionId) {
  section('[4/8] POST /v1/session/:id/action — fill login form + submit (sync)');
  info('actions: fill username → fill password → click Login → wait for result...');
  const t4 = Date.now();

  const actionRes = await req('POST', `/v1/session/${sessionId}/action`, {
    actions: [
      { type: 'fill',     selector: '#username',          value: 'tomsmith' },
      { type: 'fill',     selector: '#password',          value: 'SuperSecretPassword!' },
      { type: 'click',    selector: 'button[type="submit"]' },
      { type: 'wait_for', selector: '#flash',             timeout: 8000 },
    ],
  });

  if (actionRes.ok) {
    const results = actionRes.data.results ?? [];
    const allOk   = results.every(r => r.ok);
    if (allOk) pass(`all ${results.length} actions succeeded  (${Date.now()-t4}ms)`);
    else fail(`action failed: ${JSON.stringify(results.find(r => !r.ok))}`);
    results.forEach(r => info(`  ${r.type}: ${r.durationMs}ms ${r.ok ? '✓' : '✗ ' + r.error}`));
    pass(`landed on: ${actionRes.data.state?.url}`);

    // Verify the flash message contains login success
    const flashText = actionRes.data.state?.text ?? '';
    if (flashText.toLowerCase().includes('secure')) {
      pass(`login SUCCESS confirmed in page text ✔`);
    } else if (flashText.toLowerCase().includes('invalid')) {
      fail(`login failed — got: "${flashText.slice(0, 80)}"`);
    } else {
      info(`page text snippet: "${flashText.slice(0, 120)}"`);
    }

    // Show what the results page looks like to an AI agent
    const state = actionRes.data.state;
    info(`headings on results page: ${state?.headings?.map(h => h.text).join(' | ')}`);
    info(`links available: ${state?.links?.slice(0,3).map(l => l.text).join(', ')}`);
  } else {
    fail(`Action request failed: ${JSON.stringify(actionRes.data)}`);
  }

  // ── 4b. SSE streaming action test ─────────────────────────────────────────
  section('[4b/8] POST /v1/session/:id/action/stream — SSE real-time telemetry');
  info('opening a fresh session then streaming 3 actions via SSE...');

  // Open a fresh login session for the SSE test
  const sseSessionReq = await req('POST', '/v1/session', { url: 'https://the-internet.herokuapp.com/login' });
  let sseSessionId = null;
  if (sseSessionReq.status === 201) {
    sseSessionId = sseSessionReq.data.sessionId;
    info(`SSE test session created: ${sseSessionId}`);
  } else {
    fail(`SSE session create failed: ${JSON.stringify(sseSessionReq.data)}`);
  }

  if (sseSessionId) {
    const sseT = Date.now();
    const sseRes = await fetch(`${BASE}/v1/session/${sseSessionId}/action/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: [
          { type: 'fill',     selector: '#username', value: 'tomsmith' },
          { type: 'fill',     selector: '#password', value: 'SuperSecretPassword!' },
          { type: 'click',    selector: 'button[type="submit"]' },
          { type: 'wait_for', selector: '#flash', timeout: 8000 },
        ],
      }),
    });

    if (sseRes.status === 200 && sseRes.headers.get('content-type')?.includes('text/event-stream')) {
      pass(`HTTP 200 with Content-Type: text/event-stream`);

      // Parse the SSE stream
      let rawText = '';
      for await (const chunk of sseRes.body) {
        rawText += new TextDecoder().decode(chunk, { stream: true });
      }

      // Parse SSE events from raw text
      const events = [];
      for (const block of rawText.split('\n\n').filter(Boolean)) {
        const eventLine = block.split('\n').find(l => l.startsWith('event:'));
        const dataLine  = block.split('\n').find(l => l.startsWith('data:'));
        if (eventLine && dataLine) {
          events.push({ event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
        }
      }

      const actionResults = events.filter(e => e.event === 'action_result');
      const doneEvent     = events.find(e => e.event === 'done');

      if (actionResults.length >= 3) {
        pass(`received ${actionResults.length} action_result events in real-time`);
        actionResults.forEach(e => info(`  step ${e.data.step}/${e.data.total}: ${e.data.type} → ${e.data.ok ? '✓' : '✗'} (${e.data.durationMs}ms)`));
      } else {
        fail(`Expected ≥3 action_result events, got ${actionResults.length}`);
      }

      if (doneEvent) {
        pass(`received done event (success=${doneEvent.data.success}, ${doneEvent.data.completedSteps}/${doneEvent.data.totalSteps} steps)  (${Date.now()-sseT}ms total)`);
        if (doneEvent.data.state?.url?.includes('secure')) {
          pass(`SSE login SUCCESS — landed on secure page ✔`);
        } else {
          info(`done event page URL: ${doneEvent.data.state?.url}`);
        }
      } else {
        fail('No done event received in SSE stream');
      }
    } else {
      fail(`SSE endpoint returned ${sseRes.status} or wrong content-type: ${sseRes.headers.get('content-type')}`);
    }

    // Cleanup SSE session
    await req('DELETE', `/v1/session/${sseSessionId}`);
    info(`SSE session ${sseSessionId} cleaned up`);
  }

  // ── 5. Read current page state ───────────────────────────────────────────────
  section('[5/8] GET /v1/session/:id — read secure page state');
  const t5 = Date.now();
  const snap = await req('GET', `/v1/session/${sessionId}`);
  if (snap.ok) {
    pass(`HTTP 200  (${Date.now()-t5}ms)`);
    pass(`${snap.data.state?.links?.length} links on page`);
    pass(`${snap.data.state?.headings?.length} headings`);
    info(`URL: ${snap.data.state?.url}`);
  } else {
    fail(`Get session failed: ${JSON.stringify(snap.data)}`);
  }

  // ── 6. Delete session ─────────────────────────────────────────────────────────
  section('[6/8] DELETE /v1/session/:id — close session');
  const del = await req('DELETE', `/v1/session/${sessionId}`);
  if (del.ok && del.data.ok) pass(`session ${sessionId} destroyed`);
  else fail(`Delete failed: ${JSON.stringify(del.data)}`);

  const gone = await req('GET', `/v1/session/${sessionId}`);
  if (gone.status === 404) pass('session correctly returns 404 after deletion');
  else fail(`Expected 404, got ${gone.status}`);
}

// ── 7. Legacy browse stream ────────────────────────────────────────────────────
section('[7/8] POST /v1/browse — semantic token stream');
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
