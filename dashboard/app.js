/**
 * app.js — Production Dashboard Client
 *
 * Data sources (ALL REAL — no simulation):
 *   WS  /ws/stats    → pool stats, request counters, memory (1s push)
 *   GET /v1/health   → full memory breakdown, uptime (polled every 5s as fallback)
 *   POST /v1/browse  → live browse request, streaming token response
 *
 * Connection model:
 *   Primary  → WebSocket (zero-latency push updates)
 *   Fallback → HTTP polling /v1/health every 5s if WS drops
 */

'use strict';

// ── Server URL Detection ──────────────────────────────────────
// When served from Fastify (production): same origin.
// When opened as a local file (file://): fall back to localhost:3001.
const SERVER_ORIGIN = location.protocol === 'file:'
  ? 'http://127.0.0.1:3001'
  : location.origin;

const WS_URL     = SERVER_ORIGIN.replace(/^http/, 'ws') + '/ws/stats';
const HEALTH_URL = SERVER_ORIGIN + '/v1/health';
const BROWSE_URL = SERVER_ORIGIN + '/v1/browse';

// Update the offline banner with the right URL
document.getElementById('server-url-banner').textContent = SERVER_ORIGIN;

// ── State ─────────────────────────────────────────────────────
const STATE = {
  connected:  false,
  // Real data from server
  active:     0,
  idle:       0,
  queued:     0,
  total:      0,
  maxBrowsers: 4,
  estimatedMemMB: 0,
  nodeMemMB:  0,
  heapUsedMB: 0,
  heapTotalMB:0,
  externalMB: 0,
  uptime:     0,
  totalRequests: 0,
  totalErrors:   0,
  totalTokens:   0,
  // Ring buffers for chart (120 × 1s = 2 min)
  activeSeries:  [],
  queuedSeries:  [],
  historyLen:    120,
  // Session request history
  sessionRequests: [],
  sessionCount:    0,
  // Log
  log:    [],
  maxLog: 150,
};

// ── Log ───────────────────────────────────────────────────────
function addLog(level, msg) {
  const d  = new Date();
  const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  STATE.log.unshift({ ts, level, msg });
  if (STATE.log.length > STATE.maxLog) STATE.log.pop();
  renderLog();
}
function pad(n) { return String(n).padStart(2, '0'); }

// ── WebSocket Connection ──────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;
let pollTimer = null;

function connectWS() {
  if (ws && ws.readyState < 2) return; // already open or connecting

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    STATE.connected = true;
    setConnectionState('live');
    clearTimeout(wsReconnectTimer);
    stopPoll();
    addLog('ok', `WebSocket connected → ${WS_URL}`);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      applyServerStats(data);
    } catch { /* ignore malformed */ }
  };

  ws.onclose = () => {
    STATE.connected = false;
    setConnectionState('offline');
    addLog('warn', 'WebSocket disconnected — falling back to HTTP polling');
    startPoll();
    wsReconnectTimer = setTimeout(connectWS, 5000);
  };

  ws.onerror = () => {
    setConnectionState('offline');
    addLog('error', `Cannot reach server at ${SERVER_ORIGIN} — is "npm run dev" running?`);
  };
}

// ── HTTP Polling Fallback ─────────────────────────────────────
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(fetchHealth, 5000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function fetchHealth() {
  try {
    const res  = await fetch(HEALTH_URL);
    const data = await res.json();

    applyServerStats({
      active:           data.pool.active,
      idle:             data.pool.idle,
      queued:           data.pool.queued,
      total:            data.pool.total,
      maxBrowsers:      data.pool.maxBrowsers,
      estimatedMemoryMB:data.pool.estimatedMemoryMB,
      nodeMemMB:        data.memory.rss_mb,
      uptime:           data.uptime,
      totalRequests:    data.requests.total,
      totalErrors:      data.requests.errors,
      totalTokens:      data.requests.tokens,
    });

    // Also grab heap details
    STATE.heapUsedMB  = parseFloat(data.memory.heap_used_mb);
    STATE.heapTotalMB = parseFloat(data.memory.heap_total_mb);
    STATE.externalMB  = parseFloat(data.memory.external_mb);

    if (!STATE.connected) {
      setConnectionState('polling');
    }
  } catch {
    setConnectionState('offline');
  }
}

// ── Apply Stats ───────────────────────────────────────────────
function applyServerStats(data) {
  STATE.active      = data.active      ?? STATE.active;
  STATE.idle        = data.idle        ?? STATE.idle;
  STATE.queued      = data.queued      ?? STATE.queued;
  STATE.total       = data.total       ?? STATE.total;
  STATE.maxBrowsers = data.maxBrowsers ?? STATE.maxBrowsers;
  STATE.estimatedMemMB = data.estimatedMemoryMB ?? data.estimatedMemMB ?? STATE.estimatedMemMB;
  STATE.nodeMemMB   = parseFloat(data.nodeMemMB ?? STATE.nodeMemMB);
  STATE.uptime      = data.uptime      ?? STATE.uptime;
  STATE.totalRequests = data.totalRequests ?? STATE.totalRequests;
  STATE.totalErrors   = data.totalErrors   ?? STATE.totalErrors;
  STATE.totalTokens   = data.totalTokens   ?? STATE.totalTokens;

  // Push into chart ring buffers
  STATE.activeSeries.push(STATE.active);
  STATE.queuedSeries.push(STATE.queued);
  if (STATE.activeSeries.length > STATE.historyLen) { STATE.activeSeries.shift(); STATE.queuedSeries.shift(); }

  renderAll();
}

// ── Connection State UI ───────────────────────────────────────
function setConnectionState(state) {
  const badge = document.getElementById('conn-badge');
  const label = document.getElementById('conn-label');
  const dot   = document.getElementById('conn-dot');
  const wsDot = document.getElementById('dot-ws');
  const banner = document.getElementById('offline-banner');

  if (state === 'live') {
    badge.className = 'conn-badge conn-live';
    label.textContent = 'LIVE';
    dot.className   = 'conn-dot';
    wsDot.className = 'status-dot dot-green';
    setText('ws-status-label', 'connected');
    banner.style.display = 'none';
  } else if (state === 'polling') {
    badge.className = 'conn-badge conn-polling';
    label.textContent = 'POLLING';
    dot.className   = 'conn-dot';
    wsDot.className = 'status-dot dot-yellow';
    setText('ws-status-label', 'http poll');
    banner.style.display = 'none';
  } else {
    badge.className = 'conn-badge conn-offline';
    label.textContent = 'OFFLINE';
    dot.className   = 'conn-dot dot-dead';
    wsDot.className = 'status-dot dot-red';
    setText('ws-status-label', 'disconnected');
    banner.style.display = 'flex';
  }
}

// ── Render: All ───────────────────────────────────────────────
function renderAll() {
  renderTopbar();
  renderKPIs();
  renderChart();
  renderGauge();
  renderTheory();
}

// ── Render: Topbar ────────────────────────────────────────────
function renderTopbar() {
  const s  = STATE.uptime;
  const hh = pad(Math.floor(s / 3600));
  const mm = pad(Math.floor((s % 3600) / 60));
  const ss = pad(s % 60);
  setText('uptime-display', `${hh}:${mm}:${ss}`);
  setText('node-rss-top', STATE.nodeMemMB ? `${STATE.nodeMemMB} MB` : '—');
}

// ── Render: KPIs ─────────────────────────────────────────────
function renderKPIs() {
  const max    = STATE.maxBrowsers;
  const memPct = STATE.estimatedMemMB ? (STATE.estimatedMemMB / 512) * 100 : 0;
  const rssNum = parseFloat(STATE.nodeMemMB) || 0;
  const rssPct = (rssNum / 512) * 100;

  setNum('kpi-active',  STATE.active);
  setNum('kpi-queued',  STATE.queued);
  setNum('kpi-served',  STATE.totalRequests);
  setNum('kpi-tokens',  STATE.totalTokens);
  setText('kpi-mem',   `${STATE.estimatedMemMB || rssNum.toFixed(0)} MB`);
  setText('kpi-pool-max', max);
  setText('kpi-errors-sub', `${STATE.totalErrors} error${STATE.totalErrors === 1 ? '' : 's'}`);

  setBarWidth('kpi-active-bar', max > 0 ? (STATE.active / max) * 100 : 0);
  setBarWidth('kpi-queued-bar', (STATE.queued / 20) * 100);
  setBarWidth('kpi-mem-bar',    Math.max(memPct, rssPct));

  const memBar = document.getElementById('kpi-mem-bar');
  if (memBar) {
    const pct = Math.max(memPct, rssPct);
    memBar.style.background = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#8b5cf6';
  }

  const activeTile = document.getElementById('kpi-active-tile');
  if (activeTile) {
    activeTile.style.borderColor = STATE.active >= max ? 'rgba(245,158,11,0.4)' : '';
  }
}

// ── Render: Chart ─────────────────────────────────────────────
function renderChart() {
  const canvas = document.getElementById('concurrency-canvas');
  if (!canvas) return;
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;

  if (canvas.width !== Math.round(rect.width * dpr)) {
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }

  const ctx = canvas.getContext('2d');
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const n      = STATE.activeSeries.length;
  const maxVal = Math.max(STATE.maxBrowsers + 2, ...STATE.activeSeries, ...STATE.queuedSeries, 2);

  // Grid
  for (let i = 0; i <= 4; i++) {
    const y = H - (i / 4) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1; ctx.stroke();
  }

  // Y labels
  const yEl = document.getElementById('chart-y-labels');
  if (yEl) {
    yEl.innerHTML = '';
    for (let i = 4; i >= 0; i--) {
      const span = document.createElement('span');
      span.textContent = Math.round((i / 4) * maxVal);
      yEl.appendChild(span);
    }
  }

  if (n < 2) {
    ctx.fillStyle = 'rgba(139,170,200,0.2)';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for data from server…', W / 2, H / 2);
    return;
  }

  // Pool ceiling
  const ceilY = H - (STATE.maxBrowsers / maxVal) * H;
  ctx.beginPath(); ctx.setLineDash([5,5]);
  ctx.moveTo(0, ceilY); ctx.lineTo(W, ceilY);
  ctx.strokeStyle = 'rgba(239,68,68,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(239,68,68,0.7)';
  ctx.font = '500 9px Inter, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`POOL CEILING (${STATE.maxBrowsers})`, 4, ceilY - 4);

  function drawArea(series, lineColor, gradTop, gradBot) {
    if (series.length < 2) return;
    const stepX  = W / (STATE.historyLen - 1);
    const startX = (STATE.historyLen - series.length) * stepX;
    const pts    = series.map((v, i) => ({ x: startX + i * stepX, y: H - (v / maxVal) * H }));
    const grad   = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, gradTop); grad.addColorStop(1, gradBot);
    ctx.beginPath(); ctx.moveTo(pts[0].x, H);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length-1].x, H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    pts.forEach((p,i) => i===0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = lineColor; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    const last = pts[pts.length-1];
    ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI*2);
    ctx.fillStyle = lineColor; ctx.fill();
    ctx.beginPath(); ctx.arc(last.x, last.y, 8, 0, Math.PI*2);
    ctx.strokeStyle = lineColor+'50'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  drawArea(STATE.queuedSeries, '#f59e0b', 'rgba(245,158,11,0.18)', 'rgba(245,158,11,0.01)');
  drawArea(STATE.activeSeries, '#3b82f6', 'rgba(59,130,246,0.22)',  'rgba(59,130,246,0.01)');
}

// ── Render: Memory Gauge ──────────────────────────────────────
function renderGauge() {
  const canvas = document.getElementById('memory-gauge');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const size = 180;
  canvas.width  = size * dpr; canvas.height = size * dpr;
  canvas.style.width = size+'px'; canvas.style.height = size+'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, size, size);

  // Use real RSS from Node
  const rssNum = parseFloat(STATE.nodeMemMB) || STATE.estimatedMemMB || 80;
  const pct    = Math.min(rssNum / 512, 1);
  let   color  = '#22c55e';
  if (pct > 0.80) color = '#ef4444';
  else if (pct > 0.60) color = '#f59e0b';

  const cx = size/2, cy = size/2+8, r = 72;
  const startA = Math.PI * 0.75, span = Math.PI * 1.5;

  ctx.beginPath(); ctx.arc(cx,cy,r,startA,startA+span);
  ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=12; ctx.lineCap='round'; ctx.stroke();

  [[0.60,'#22c55e22'],[0.80,'#f59e0b22'],[1.00,'#ef444422']].reduce((prev, [end, col]) => {
    ctx.beginPath(); ctx.arc(cx,cy,r,startA+span*prev,startA+span*end);
    ctx.strokeStyle=col; ctx.lineWidth=12; ctx.lineCap='butt'; ctx.stroke();
    return end;
  }, 0);

  if (pct > 0) {
    ctx.beginPath(); ctx.arc(cx,cy,r,startA,startA+span*pct);
    ctx.strokeStyle=color; ctx.lineWidth=12; ctx.lineCap='round';
    ctx.shadowColor=color; ctx.shadowBlur=8; ctx.stroke(); ctx.shadowBlur=0;
  }

  ctx.textAlign='center';
  ctx.fillStyle=color; ctx.font=`700 22px 'JetBrains Mono',monospace`;
  ctx.fillText(Math.round(rssNum), cx, cy-4);
  ctx.fillStyle='rgba(148,163,184,0.8)'; ctx.font='400 10px Inter,sans-serif';
  ctx.fillText('MB RSS', cx, cy+11);
  ctx.fillStyle='rgba(71,85,105,0.9)'; ctx.font='400 9px Inter,sans-serif';
  ctx.fillText(`${(pct*100).toFixed(0)}% of 512 MB ceiling`, cx, cy+26);

  // Breakdown bars
  const heapPct = STATE.heapUsedMB ? (STATE.heapUsedMB/512)*100 : 0;
  const rssPct  = (rssNum/512)*100;
  const extPct  = STATE.externalMB ? (STATE.externalMB/512)*100 : 0;
  setBarWidth('bar-heap', heapPct); setText('mb-heap', STATE.heapUsedMB ? `${parseFloat(STATE.heapUsedMB).toFixed(1)} MB` : '—');
  setBarWidth('bar-rss',  rssPct);  setText('mb-rss',  `${rssNum.toFixed(1)} MB`);
  setBarWidth('bar-ext',  extPct);  setText('mb-ext',  STATE.externalMB ? `${parseFloat(STATE.externalMB).toFixed(1)} MB` : '—');
}

// ── Render: Theory ────────────────────────────────────────────
function renderTheory() {
  const L      = (STATE.active + STATE.queued).toFixed(1);
  const lambdaE = STATE.uptime > 2 ? (STATE.totalRequests / STATE.uptime).toFixed(2) : '0.00';
  const rho    = STATE.maxBrowsers > 0 ? STATE.active / STATE.maxBrowsers : 0;

  setNum('ll-L',      L);
  setText('ll-lambda', `${lambdaE}/s`);
  setText('ll-rho',   `${(rho*100).toFixed(0)}%`);
  setNum('ll-tokens', STATE.totalTokens);

  const rhoBar = document.getElementById('rho-bar');
  if (rhoBar) {
    rhoBar.style.width      = `${Math.min(rho,1)*100}%`;
    rhoBar.style.background = rho > 0.9 ? '#ef4444' : rho > 0.7 ? '#f59e0b' : '#22c55e';
  }
}

// ── Render: Log ───────────────────────────────────────────────
function renderLog() {
  const el = document.getElementById('log-terminal');
  if (!el) return;
  el.innerHTML = STATE.log.slice(0, 80).map(e => {
    const cls   = e.level === 'warn' ? 'log-line-warn' : e.level === 'error' ? 'log-line-error' : '';
    const badge = e.level === 'warn' ? 'badge-warn' : e.level === 'error' ? 'badge-error' : e.level === 'ok' ? 'badge-ok' : 'badge-info';
    const label = e.level === 'warn' ? 'WARN' : e.level === 'error' ? 'ERR' : e.level === 'ok' ? 'OK' : 'INFO';
    return `<div class="log-line ${cls}"><span class="log-ts">${e.ts}</span><span class="log-badge ${badge}">${label}</span><span class="log-msg">${e.msg}</span></div>`;
  }).join('');
}

// ── Browse Request ────────────────────────────────────────────
let sessionRequestId = 0;
const historyRows    = [];

async function doBrowse() {
  const rawUrl = document.getElementById('browse-url').value.trim();
  if (!rawUrl) { document.getElementById('browse-url').focus(); return; }

  // Normalise URL
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  const waitUntil = document.getElementById('wait-until-select').value;

  const resultBox   = document.getElementById('browse-result');
  const loadingBox  = document.getElementById('browse-loading');
  const tokenStream = document.getElementById('token-stream');
  const btn         = document.getElementById('btn-browse');

  btn.disabled = true;
  loadingBox.style.display = 'flex';
  resultBox.style.display  = 'none';
  tokenStream.textContent  = '';

  const id     = ++sessionRequestId;
  const start  = Date.now();

  addLog('info', `Browse #${id} → ${url} (${waitUntil})`);

  // Add a pending row to history
  const row = { id, url, state: 'active', duration: null, tokens: null, error: null };
  historyRows.unshift(row);
  renderHistory();

  try {
    const res = await fetch(BROWSE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url, waitUntil }),
    });

    loadingBox.style.display = 'none';
    resultBox.style.display  = 'block';

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const msg = err.error || res.statusText;
      tokenStream.textContent = `Error ${res.status}: ${msg}`;
      setBrowseResultBadge('error', `${res.status}`, null);
      row.state = 'error'; row.error = msg; row.duration = Date.now() - start;
      addLog('error', `Browse #${id} failed: ${msg}`);
    } else {
      // Stream the response text
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let tokenCount = 0;
      let fullText   = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        // Count token lines
        tokenCount = (fullText.match(/^\[#\d+\]/gm) || []).length;
        tokenStream.textContent = fullText;
        tokenStream.scrollTop   = tokenStream.scrollHeight;
        setBrowseResultBadge('success', `${tokenCount} tokens`, Date.now() - start);
      }

      const finalDuration = Date.now() - start;
      row.state    = 'done';
      row.tokens   = tokenCount;
      row.duration = finalDuration;
      setBrowseResultBadge('success', `${tokenCount} tokens`, finalDuration);
      addLog('ok', `Browse #${id} complete → ${tokenCount} tokens in ${finalDuration}ms`);
    }
  } catch (e) {
    loadingBox.style.display = 'none';
    resultBox.style.display  = 'block';
    tokenStream.textContent = `Network error: ${e.message}\n\nMake sure the proxy server is running at ${SERVER_ORIGIN}`;
    setBrowseResultBadge('error', 'Network error', null);
    row.state = 'error'; row.error = e.message; row.duration = Date.now() - start;
    addLog('error', `Browse #${id} network error: ${e.message}`);
  }

  btn.disabled = false;
  renderHistory();
  setText('session-count', `${historyRows.length} request${historyRows.length === 1 ? '' : 's'}`);
}

function setBrowseResultBadge(type, label, durationMs) {
  const badge = document.getElementById('result-badge');
  const stat  = document.getElementById('result-stat');
  badge.className = `result-badge result-badge-${type}`;
  badge.textContent = type === 'success' ? '✓ ' + label : '✗ ' + label;
  stat.textContent  = durationMs !== null ? `${durationMs}ms` : '';
}

function renderHistory() {
  const tbody = document.getElementById('history-tbody');
  if (!tbody) return;
  if (historyRows.length === 0) {
    tbody.innerHTML = `<tr class="queue-empty-row"><td colspan="5"><div class="empty-state"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Use the Test Browse panel above</div></td></tr>`;
    return;
  }
  tbody.innerHTML = historyRows.map(r => {
    let pill;
    if (r.state === 'active')      pill = `<span class="status-pill pill-active"><span class="pill-dot anim"></span>Browsing</span>`;
    else if (r.state === 'done')   pill = `<span class="status-pill pill-done"><span class="pill-dot"></span>Done</span>`;
    else                           pill = `<span class="status-pill pill-rejected"><span class="pill-dot"></span>Error</span>`;
    const dur = r.duration !== null ? `${r.duration}ms` : '—';
    const tok = r.tokens   !== null ? `<span class="tok-cell">${r.tokens}</span>` : '—';
    return `<tr>
      <td><span class="id-chip">#${r.id}</span></td>
      <td>${pill}</td>
      <td><span class="url-cell" title="${r.url}">${r.url.replace(/^https?:\/\//, '')}</span></td>
      <td><span class="dur-cell">${dur}</span></td>
      <td>${tok}</td>
    </tr>`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────
function setNum(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = typeof val === 'number' ? val.toLocaleString() : (val ?? '—');
}
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}
function setBarWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.min(100, Math.max(0, pct || 0)).toFixed(1) + '%';
}

// ── Canvas resize ─────────────────────────────────────────────
function handleResize() {
  requestAnimationFrame(() => { renderChart(); renderGauge(); });
}

// ── Controls Wiring ───────────────────────────────────────────
function wireControls() {
  // Browse button
  document.getElementById('btn-browse').addEventListener('click', doBrowse);

  // Enter key in URL input
  document.getElementById('browse-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doBrowse();
  });

  // Quick URL buttons
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('browse-url').value = btn.dataset.url;
      doBrowse();
    });
  });

  // Copy tokens
  document.getElementById('btn-copy-tokens').addEventListener('click', () => {
    const text = document.getElementById('token-stream').textContent;
    navigator.clipboard.writeText(text).then(() => {
      document.getElementById('btn-copy-tokens').textContent = 'Copied!';
      setTimeout(() => { document.getElementById('btn-copy-tokens').textContent = 'Copy tokens'; }, 2000);
    });
  });

  // Clear log
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    STATE.log = [];
    addLog('info', 'Log cleared');
  });

  // Nav smooth scroll + active highlight
  document.querySelectorAll('.nav-item:not(.nav-api)').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
    });
  });

  // Resize
  window.addEventListener('resize', handleResize);
}

// ── Health poll for heap details that WS doesn't send ─────────
async function pollHeapDetails() {
  try {
    const res  = await fetch(HEALTH_URL);
    const data = await res.json();
    STATE.heapUsedMB  = parseFloat(data.memory.heap_used_mb);
    STATE.heapTotalMB = parseFloat(data.memory.heap_total_mb);
    STATE.externalMB  = parseFloat(data.memory.external_mb);
    setState_redis(true); // if we got here, server is up
  } catch { /* ignore */ }
}

function setState_redis(up) {
  document.getElementById('dot-redis').className  = 'status-dot dot-yellow';
  document.getElementById('dot-db').className     = 'status-dot dot-yellow';
  setText('redis-status-label', 'fail-open');
  setText('db-status-label',    'skipped');
}

// ── Bootstrap ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  wireControls();
  connectWS();
  // Poll heap details every 5s (WS doesn't include full breakdown)
  setInterval(pollHeapDetails, 5000);
  pollHeapDetails();
  // Initial render with blank state
  renderAll();
  addLog('info', `Connecting to ${SERVER_ORIGIN}`);
});
