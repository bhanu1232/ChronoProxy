/**
 * browser.ts — Lean Chromium Launcher
 *
 * Initializes a Playwright Chromium instance with aggressive resource-kill flags.
 * Memory budget: ~80–100MB per instance (headless, no GPU, no images).
 * All visual and non-semantic assets are blocked at the network routing layer
 * before Blink even begins to decode them — eliminating wasted allocation.
 */

import { chromium, Browser, BrowserContext } from 'playwright';

/**
 * Resource types that are completely irrelevant to semantic extraction.
 * Blocking these at the network layer prevents Chromium from allocating
 * decode buffers, texture memory, or audio pipeline state.
 */
const BLOCKED_RESOURCE_TYPES = new Set([
  'image',
  'media',
  'font',
  'stylesheet',
  'ping',
  'csp_report',
  'manifest',
  'other',
]);

export interface BrowserBundle {
  browser: Browser;
  context: BrowserContext;
}

/**
 * launchLeanBrowser
 *
 * Spins up one Chromium process configured for absolute minimum RAM usage.
 * The returned context already has network-level blocking applied so callers
 * never need to think about asset interception themselves.
 */
export async function launchLeanBrowser(): Promise<BrowserBundle> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      // ── GPU & Rendering ─────────────────────────────────────────────────
      '--disable-gpu',                      // No OpenGL/Vulkan allocation
      '--disable-gpu-compositing',          // Skip GPU-backed layer compositing
      '--disable-software-rasterizer',      // No fallback CPU rasterizer either
      '--disable-canvas-aa',               // No anti-aliasing compute cost

      // ── Shared Memory & IPC ─────────────────────────────────────────────
      '--disable-dev-shm-usage',            // Use /tmp instead of /dev/shm (container-safe)
      '--ipc-connection-timeout=10000',     // Fail fast on broken IPC pipes

      // ── Security Sandbox (container-safe) ───────────────────────────────
      '--no-sandbox',
      '--disable-setuid-sandbox',

      // ── Extensions & Background Services ────────────────────────────────
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',

      // ── Images & Media (belt-and-suspenders with route blocking) ────────
      '--blink-settings=imagesEnabled=false',
      '--disable-image-loading',

      // ── V8 Memory Limits ─────────────────────────────────────────────────
      '--js-flags=--max-old-space-size=64', // Cap JS heap per Chromium child
    ],
  });

  // Isolated browser context: no cookies, no cache, no persistent storage.
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36 SemanticProxy/1.0',
    // Smallest meaningful viewport — Chromium still needs one but allocates
    // proportionally to canvas size, so we keep it tiny.
    viewport: { width: 800, height: 600 },
    // Disable JavaScript where the target site doesn't need it for initial HTML.
    // Callers can override per-page if needed.
    javaScriptEnabled: true,
    // No persistent storage reduces disk I/O and eliminates cache growth.
    storageState: undefined,
  });

  // ── Network-layer resource blocking ────────────────────────────────────────
  // This intercepts at the fetch/XHR layer BEFORE Chromium allocates any decode
  // buffer, giving us true O(0) cost for blocked resource types.
  await context.route('**/*', (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  return { browser, context };
}
