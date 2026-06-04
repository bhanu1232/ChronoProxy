/**
 * simulation.js — Discrete-Event M/M/c/K Queue Simulation Engine
 *
 * Models the SemanticProxy browser pool as a queuing system:
 *   λ  = arrival rate (req/s)          — Poisson process
 *   μ  = service rate per browser      — Exponential distribution
 *   c  = pool size (server count)
 *   K  = system capacity (c + maxQueue)
 *   ρ  = λ/(c·μ)  server utilization
 *   L  = avg requests in system        — Little's Law
 *   W  = avg latency per request       — Little's Law: W = L/λ
 */

'use strict';

// ── Simulation State ──────────────────────────────────────────

const SIM = {
  lambda:        5,
  avgServiceMs:  3000,
  maxBrowsers:   4,
  maxQueue:      20,
  rateLimitOn:   true,
  rateLimitMax:  30,
  paused:        false,

  activeBrowsers:  0,
  queuedRequests:  0,
  totalArrived:    0,
  totalServed:     0,
  totalRejected:   0,
  totalTokens:     0,
  estimatedMemMB:  80,
  uptimeMs:        0,
  lastTick:        0,

  ipWindows:   {},
  requests:    [],
  nextId:      1,

  // Ring buffers for chart (120 samples × 500ms = 60 seconds of history)
  historyLen:    120,
  activeSeries:  [],
  queuedSeries:  [],
  timeLabels:    [],

  // Little's Law
  sumServed:   0,

  // Log
  log:         [],
  maxLog:      200,
};

// ── Fake Data ─────────────────────────────────────────────────

const URLS = [
  'news.ycombinator.com',
  'reddit.com/r/technology',
  'github.com/trending',
  'stackoverflow.com/questions',
  'producthunt.com',
  'techcrunch.com',
  'arxiv.org/cs.AI',
  'dev.to/latest',
  'medium.com',
  'lobste.rs',
];

const IPS = Array.from({ length: 16 }, (_, i) =>
  `10.${Math.floor(i/4)+1}.${(i*17)%255}.${(i*31+7)%255}`
);

const fakeUrl = () => URLS[Math.floor(Math.random() * URLS.length)];
const fakeIp  = () => IPS[Math.floor(Math.random() * IPS.length)];
const fakeTokens = () => Math.floor(Math.random() * 200) + 15;
const fakeServiceMs = () => SIM.avgServiceMs * (0.4 + Math.random() * 1.2);

// ── Arrival (Poisson) ─────────────────────────────────────────

let lambdaAcc = 0;

function countArrivals(dtMs) {
  lambdaAcc += (SIM.lambda * dtMs) / 1000;
  const n = Math.floor(lambdaAcc);
  lambdaAcc -= n;
  return n;
}

// ── Rate Limiter ──────────────────────────────────────────────

function isRateLimited(ip) {
  if (!SIM.rateLimitOn) return false;
  const now = Date.now();
  const window = 60_000;
  if (!SIM.ipWindows[ip]) SIM.ipWindows[ip] = [];
  SIM.ipWindows[ip] = SIM.ipWindows[ip].filter(t => now - t < window);
  if (SIM.ipWindows[ip].length >= SIM.rateLimitMax) return true;
  SIM.ipWindows[ip].push(now);
  return false;
}

// ── Request Lifecycle ─────────────────────────────────────────

function arrive() {
  const ip  = fakeIp();
  const url = fakeUrl();
  SIM.totalArrived++;

  if (isRateLimited(ip)) {
    SIM.totalRejected++;
    addLog('warn', `429 rate-limited ${ip} → ${url}`);
    return;
  }

  const req = {
    id:        SIM.nextId++,
    ip, url,
    state:     'waiting',
    arrivedAt: performance.now(),
    startedAt: null,
    tokens:    fakeTokens(),
    serviceMs: fakeServiceMs(),
    elapsed:   0,
  };

  if (SIM.activeBrowsers < SIM.maxBrowsers) {
    startRequest(req);
  } else if (SIM.queuedRequests < SIM.maxQueue) {
    SIM.queuedRequests++;
    SIM.requests.push(req);
    addLog('info', `Queued #${req.id} from ${ip} (depth: ${SIM.queuedRequests}/${SIM.maxQueue})`);
  } else {
    SIM.totalRejected++;
    addLog('error', `503 pool + queue full — dropped #${req.id} from ${ip}`);
  }
}

function startRequest(req) {
  req.state     = 'active';
  req.startedAt = performance.now();
  SIM.activeBrowsers++;
  SIM.estimatedMemMB = 80 + SIM.activeBrowsers * 95;
  SIM.requests.push(req);
  addLog('info', `Browse ${req.url} [#${req.id}] · browsers ${SIM.activeBrowsers}/${SIM.maxBrowsers}`);
}

function tickRequests(dtMs) {
  for (const req of SIM.requests) {
    if (req.state !== 'active') continue;
    req.elapsed += dtMs;

    if (req.elapsed >= req.serviceMs) {
      req.state = 'done';
      SIM.activeBrowsers = Math.max(0, SIM.activeBrowsers - 1);
      SIM.estimatedMemMB = 80 + SIM.activeBrowsers * 95;
      SIM.totalServed++;
      SIM.totalTokens += req.tokens;
      addLog('ok', `Done #${req.id} → ${req.tokens} tokens · ${Math.round(req.elapsed)}ms · ${req.url}`);

      // Promote queued request
      const next = SIM.requests.find(r => r.state === 'waiting');
      if (next) {
        SIM.queuedRequests = Math.max(0, SIM.queuedRequests - 1);
        // Remove from list and re-start
        SIM.requests = SIM.requests.filter(r => r !== next);
        startRequest(next);
      }
    }
  }

  // Prune old done requests — keep last 5 for display
  const done    = SIM.requests.filter(r => r.state === 'done');
  const active  = SIM.requests.filter(r => r.state === 'active');
  const waiting = SIM.requests.filter(r => r.state === 'waiting');
  SIM.requests  = [...active, ...waiting, ...done.slice(-5)];
}

// ── History Buffer ────────────────────────────────────────────

let histTimer = 0;

function recordHistory(dtMs) {
  histTimer += dtMs;
  if (histTimer < 500) return;
  histTimer = 0;

  SIM.activeSeries.push(SIM.activeBrowsers);
  SIM.queuedSeries.push(SIM.queuedRequests);

  if (SIM.activeSeries.length > SIM.historyLen) {
    SIM.activeSeries.shift();
    SIM.queuedSeries.shift();
  }
}

// ── Event Log ─────────────────────────────────────────────────

function addLog(level, msg) {
  const d   = new Date();
  const ts  = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  SIM.log.unshift({ ts, level, msg });
  if (SIM.log.length > SIM.maxLog) SIM.log.pop();
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── Simulation Tick ───────────────────────────────────────────

function tick(now) {
  if (!SIM.lastTick) SIM.lastTick = now;

  if (!SIM.paused) {
    const dt = Math.min(now - SIM.lastTick, 100);
    SIM.uptimeMs += dt;

    const arrivals = countArrivals(dt);
    for (let i = 0; i < arrivals; i++) arrive();

    tickRequests(dt);
    recordHistory(dt);
  }

  SIM.lastTick = now;
  renderAll();
  requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════ RENDER

function renderAll() {
  renderTopbar();
  renderKPIs();
  renderChart();
  renderGauge();
  renderQueue();
  renderLog();
  renderTheory();
}

// ── Topbar ────────────────────────────────────────────────────

function renderTopbar() {
  const s  = Math.floor(SIM.uptimeMs / 1000);
  const hh = pad(Math.floor(s / 3600));
  const mm = pad(Math.floor((s % 3600) / 60));
  const ss = pad(s % 60);
  setText('uptime-display', `${hh}:${mm}:${ss}`);
}

// ── KPIs ──────────────────────────────────────────────────────

function renderKPIs() {
  const maxB = SIM.maxBrowsers;
  const memPct = (SIM.estimatedMemMB / 512) * 100;

  setNum('kpi-active',  SIM.activeBrowsers);
  setNum('kpi-queued',  SIM.queuedRequests);
  setNum('kpi-served',  SIM.totalServed);
  setNum('kpi-rejected',SIM.totalRejected);
  setText('kpi-mem', `${SIM.estimatedMemMB} MB`);
  setText('kpi-pool-max', maxB);

  // Bars
  setBarWidth('kpi-active-bar',  (SIM.activeBrowsers / maxB) * 100);
  setBarWidth('kpi-queued-bar',  (SIM.queuedRequests / SIM.maxQueue) * 100);
  setBarWidth('kpi-mem-bar',     memPct);

  // Throughput
  const upSec = SIM.uptimeMs / 1000;
  const rps   = upSec > 2 ? (SIM.totalServed / upSec).toFixed(2) : '0.00';
  setText('kpi-rps', `${rps} req/s throughput`);

  // Reject rate
  const rr = SIM.totalArrived > 0
    ? ((SIM.totalRejected / SIM.totalArrived) * 100).toFixed(1)
    : '0.0';
  setText('kpi-reject-rate', `${rr}% rejection rate`);

  // Active tile colour
  const activeTile = document.getElementById('kpi-active-tile');
  if (activeTile) {
    activeTile.style.borderColor = SIM.activeBrowsers >= maxB
      ? 'rgba(245,158,11,0.35)' : '';
  }

  // Memory bar colour
  const memBar = document.getElementById('kpi-mem-bar');
  if (memBar) {
    memBar.style.background = memPct > 80 ? '#ef4444' : memPct > 60 ? '#f59e0b' : '#8b5cf6';
  }
}

function setBarWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + '%';
}

// ── Concurrency Chart ─────────────────────────────────────────

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

  const n      = SIM.activeSeries.length;
  const maxVal = Math.max(SIM.maxBrowsers + 2, ...SIM.activeSeries, ...SIM.queuedSeries, 1);

  // Grid lines
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = H - (i / steps) * H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Y-axis labels (update DOM)
  const yLabels = document.getElementById('chart-y-labels');
  if (yLabels) {
    yLabels.innerHTML = '';
    for (let i = steps; i >= 0; i--) {
      const val = Math.round((i / steps) * maxVal);
      const span = document.createElement('span');
      span.textContent = val;
      yLabels.appendChild(span);
    }
  }

  if (n < 2) return;

  // Pool ceiling line
  const ceilY = H - (SIM.maxBrowsers / maxVal) * H;
  ctx.beginPath();
  ctx.setLineDash([5, 5]);
  ctx.moveTo(0, ceilY);
  ctx.lineTo(W, ceilY);
  ctx.strokeStyle = 'rgba(239,68,68,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // Ceiling label
  ctx.fillStyle = 'rgba(239,68,68,0.6)';
  ctx.font = `500 9px Inter, sans-serif`;
  ctx.fillText(`POOL LIMIT (${SIM.maxBrowsers})`, 4, ceilY - 4);

  // Draw series as filled areas
  function drawArea(series, lineColor, fillStart, fillEnd) {
    if (series.length < 2) return;
    const stepX = W / (SIM.historyLen - 1);
    const startX = (SIM.historyLen - series.length) * stepX;

    // Points
    const pts = series.map((v, i) => ({
      x: startX + i * stepX,
      y: H - (v / maxVal) * H,
    }));

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, fillStart);
    grad.addColorStop(1, fillEnd);

    ctx.beginPath();
    ctx.moveTo(pts[0].x, H);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Live dot
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // Pulse ring
    ctx.beginPath();
    ctx.arc(last.x, last.y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = lineColor + '50';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Queued (behind)
  drawArea(SIM.queuedSeries, '#f59e0b', 'rgba(245,158,11,0.18)', 'rgba(245,158,11,0.01)');
  // Active (front)
  drawArea(SIM.activeSeries, '#3b82f6', 'rgba(59,130,246,0.2)',  'rgba(59,130,246,0.01)');
}

// ── Memory Gauge ──────────────────────────────────────────────

function renderGauge() {
  const canvas = document.getElementById('memory-gauge');
  if (!canvas) return;

  const dpr  = window.devicePixelRatio || 1;
  const size = 180;
  canvas.width  = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width  = size + 'px';
  canvas.style.height = size + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2 + 8;
  const r  = 72;
  const startA = Math.PI * 0.75;
  const span   = Math.PI * 1.5;

  const memMB  = SIM.estimatedMemMB;
  const pct    = Math.min(memMB / 512, 1);
  let fillColor = '#22c55e';
  if (pct > 0.80) fillColor = '#ef4444';
  else if (pct > 0.60) fillColor = '#f59e0b';

  // Track bg
  ctx.beginPath();
  ctx.arc(cx, cy, r, startA, startA + span);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Zone segments
  const zones = [
    { end: 0.60, color: '#22c55e22' },
    { end: 0.80, color: '#f59e0b22' },
    { end: 1.00, color: '#ef444422' },
  ];
  let prevA = startA;
  zones.forEach(z => {
    const endA = startA + span * z.end;
    ctx.beginPath();
    ctx.arc(cx, cy, r, prevA, endA);
    ctx.strokeStyle = z.color;
    ctx.lineWidth = 12;
    ctx.lineCap = 'butt';
    ctx.stroke();
    prevA = endA;
  });

  // Fill arc
  if (pct > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, startA + span * pct);
    ctx.strokeStyle = fillColor;
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.shadowColor = fillColor;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Center text
  ctx.textAlign = 'center';
  ctx.fillStyle = fillColor;
  ctx.font = `700 22px 'JetBrains Mono', monospace`;
  ctx.fillText(`${memMB}`, cx, cy - 4);

  ctx.fillStyle = 'rgba(148,163,184,0.8)';
  ctx.font = `400 10px Inter, sans-serif`;
  ctx.fillText('MB', cx, cy + 11);

  ctx.fillStyle = 'rgba(71,85,105,0.9)';
  ctx.font = `400 9px Inter, sans-serif`;
  ctx.fillText(`${(pct * 100).toFixed(0)}% of 512 MB`, cx, cy + 26);

  // Mem breakdown
  const browsers = SIM.activeBrowsers;
  const browserMb = browsers * 95;
  const maxBarPct = (browserMb / 512) * 100;

  setNum('browser-count', browsers);
  setText('browser-mem-mb', `${browserMb} MB`);
  setBarWidth('browser-mem-bar', maxBarPct);
}

// ── Queue Table ───────────────────────────────────────────────

function renderQueue() {
  const tbody = document.getElementById('queue-tbody');
  if (!tbody) return;

  const display = SIM.requests.slice(-8).reverse();

  const activeCount  = SIM.requests.filter(r => r.state === 'active').length;
  const waitingCount = SIM.requests.filter(r => r.state === 'waiting').length;

  setText('qs-active', `${activeCount} active`);
  setText('qs-wait',   `${waitingCount} waiting`);

  if (display.length === 0) {
    tbody.innerHTML = `
      <tr class="queue-empty-row">
        <td colspan="5">
          <div class="empty-state">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>No active requests — increase the arrival rate (λ) slider to generate traffic</span>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = display.map(req => {
    const elapsed = req.startedAt ? Math.round(performance.now() - req.startedAt) : '—';
    const dur     = req.state === 'active' ? `${elapsed}ms` : req.state === 'done' ? `${Math.round(req.elapsed)}ms` : '—';

    let pill;
    if (req.state === 'active') {
      pill = `<span class="status-pill pill-active"><span class="pill-dot anim"></span>Processing</span>`;
    } else if (req.state === 'waiting') {
      pill = `<span class="status-pill pill-waiting"><span class="pill-dot"></span>Queued</span>`;
    } else {
      pill = `<span class="status-pill pill-done"><span class="pill-dot"></span>Done</span>`;
    }

    return `
      <tr>
        <td><span class="id-chip">#${req.id}</span></td>
        <td>${pill}</td>
        <td><span class="url-cell" title="${req.url}">${req.url}</span></td>
        <td><span class="dur-cell">${dur}</span></td>
        <td><span class="tok-cell">${req.state === 'done' ? req.tokens : '—'}</span></td>
      </tr>`;
  }).join('');
}

// ── Event Log ─────────────────────────────────────────────────

function renderLog() {
  const container = document.getElementById('log-terminal');
  if (!container) return;

  // Only re-render if there are new entries (first item changed)
  const first = container.querySelector('.log-line');
  const firstMsg = first?.querySelector('.log-msg')?.textContent;
  if (SIM.log.length > 0 && firstMsg === SIM.log[0].msg) return;

  container.innerHTML = SIM.log.slice(0, 60).map(e => {
    const cls  = e.level === 'warn' ? 'log-line-warn' : e.level === 'error' ? 'log-line-error' : '';
    const badge = e.level === 'warn' ? 'badge-warn' : e.level === 'error' ? 'badge-error' : e.level === 'ok' ? 'badge-ok' : 'badge-info';
    const label = e.level === 'warn' ? 'WARN' : e.level === 'error' ? 'ERR' : e.level === 'ok' ? 'OK' : 'INFO';
    return `
      <div class="log-line ${cls}">
        <span class="log-ts">${e.ts}</span>
        <span class="log-badge ${badge}">${label}</span>
        <span class="log-msg">${e.msg}</span>
      </div>`;
  }).join('');
}

// ── Queue Theory / Little's Law ───────────────────────────────

function renderTheory() {
  const upSec   = SIM.uptimeMs / 1000;
  const L       = (SIM.activeBrowsers + SIM.queuedRequests).toFixed(1);
  const lambdaE = upSec > 1 ? (SIM.totalServed / upSec) : 0;
  const W       = lambdaE > 0 ? (parseFloat(L) / lambdaE).toFixed(2) + 's' : '—';
  const mu      = 1000 / SIM.avgServiceMs; // service rate per browser
  const rho     = (SIM.lambda / (SIM.maxBrowsers * mu));
  const rhoDisp = (Math.min(rho, 2) * 100).toFixed(0);

  setNum('ll-L', L);
  setText('ll-lambda', lambdaE > 0 ? lambdaE.toFixed(2) + '/s' : '0.00/s');
  setText('ll-W', W);
  setText('ll-rho', `${rhoDisp}%`);
  setText('ll-tokens', SIM.totalTokens.toLocaleString());

  // ρ bar colour
  const rhoBar = document.getElementById('rho-bar');
  if (rhoBar) {
    const rhoFill = Math.min(rho, 1) * 100;
    rhoBar.style.width = rhoFill.toFixed(1) + '%';
    rhoBar.style.background = rho > 1 ? '#ef4444' : rho > 0.7 ? '#f59e0b' : '#22c55e';
  }
}

// ── Helpers ───────────────────────────────────────────────────

function setNum(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = typeof val === 'number' ? val.toLocaleString() : val;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Controls ──────────────────────────────────────────────────

function wireControls() {
  // RPS
  const rpsSlider = document.getElementById('rps-slider');
  if (rpsSlider) {
    rpsSlider.addEventListener('input', () => {
      SIM.lambda = parseFloat(rpsSlider.value);
      setText('rps-badge', SIM.lambda.toFixed(1) + ' req/s');
    });
  }

  // Pool
  const poolSlider = document.getElementById('pool-slider');
  if (poolSlider) {
    poolSlider.addEventListener('input', () => {
      SIM.maxBrowsers = parseInt(poolSlider.value, 10);
      setText('pool-badge', SIM.maxBrowsers + ' browsers');
    });
  }

  // Service time
  const svcSlider = document.getElementById('svc-slider');
  if (svcSlider) {
    svcSlider.addEventListener('input', () => {
      SIM.avgServiceMs = parseInt(svcSlider.value, 10);
      setText('svc-badge', (SIM.avgServiceMs / 1000).toFixed(1) + 's');
    });
  }

  // Rate limit toggle
  const rlToggle = document.getElementById('rl-toggle');
  if (rlToggle) {
    rlToggle.addEventListener('change', () => {
      SIM.rateLimitOn = rlToggle.checked;
      setText('si-rl-status', SIM.rateLimitOn ? 'Active · 30 req/min/IP' : 'Disabled · All requests pass through');
      addLog('warn', `Rate limiting ${SIM.rateLimitOn ? 'enabled' : 'DISABLED — all IPs unrestricted'}`);
    });
  }

  // Spike (both buttons)
  ['btn-spike', 'btn-spike-top'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', injectSpike);
  });

  // Pause (both buttons)
  ['btn-pause-top'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', togglePause);
  });

  // Reset (both buttons)
  ['btn-reset', 'btn-reset-top'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', resetSim);
  });

  // Clear log
  const clearLog = document.getElementById('btn-clear-log');
  if (clearLog) clearLog.addEventListener('click', () => {
    SIM.log = [];
    addLog('info', 'Log cleared');
  });

  // Sidebar nav highlight on scroll
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
    });
  });
}

function injectSpike() {
  const burst = 20 + Math.floor(Math.random() * 25);
  addLog('warn', `⚡ TRAFFIC SPIKE — ${burst} simultaneous arrivals injected`);
  for (let i = 0; i < burst; i++) arrive();
}

function togglePause() {
  SIM.paused = !SIM.paused;
  const icon = document.getElementById('pause-icon');
  if (icon) {
    icon.innerHTML = SIM.paused
      ? '<polygon points="5 3 19 12 5 21 5 3"/>'  // play
      : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'; // pause
  }
  addLog('info', SIM.paused ? 'Simulation paused' : 'Simulation resumed');
}

function resetSim() {
  SIM.activeBrowsers = 0;
  SIM.queuedRequests = 0;
  SIM.totalArrived   = 0;
  SIM.totalServed    = 0;
  SIM.totalRejected  = 0;
  SIM.totalTokens    = 0;
  SIM.estimatedMemMB = 80;
  SIM.requests       = [];
  SIM.activeSeries   = [];
  SIM.queuedSeries   = [];
  SIM.ipWindows      = {};
  SIM.uptimeMs       = 0;
  SIM.log            = [];
  SIM.nextId         = 1;
  addLog('ok', 'Simulation reset — all counters cleared');
}

// ── Bootstrap ─────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  wireControls();
  addLog('ok',   'SemanticProxy simulation initialised');
  addLog('info', `Pool: ${SIM.maxBrowsers} browsers · ceiling: ${SIM.maxBrowsers * 95 + 80} MB`);
  addLog('info', 'Rate limiter: ON · Redis sliding window · 30 req/min per IP');
  addLog('info', 'Fail-open: enabled · requests pass through on Redis outage');
  requestAnimationFrame(tick);
});
