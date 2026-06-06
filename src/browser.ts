/**
 * browser.ts — Lean Chromium Launcher with Stealth Mode
 *
 * Initializes a Playwright Chromium instance with:
 *  1. Aggressive resource-kill flags (memory budget: ~80–100MB per instance)
 *  2. Stealth init scripts injected into every page context before any JS runs,
 *     patching the fingerprinting vectors that Cloudflare, Datadome, and Akamai
 *     rely on to detect headless browsers.
 *
 * Stealth patches applied (all via context.addInitScript):
 *  - navigator.webdriver  → undefined  (most common detection vector)
 *  - navigator.plugins    → realistic plugin list (PDF viewer, etc.)
 *  - navigator.languages  → ['en-US', 'en']
 *  - window.chrome        → fake chrome runtime object
 *  - WebGL vendor/renderer → 'Intel Inc.' / 'Intel Iris OpenGL Engine'
 *  - permissions.query    → returns 'granted' for notification prompt
 *  - navigator.platform   → 'Win32' (matches our Windows UA)
 *
 * All visual and non-semantic assets are blocked at the network routing layer
 * before Blink even begins to decode them — eliminating wasted allocation.
 */

import { execSync } from 'child_process';
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
 * The stealth init script is injected into every page context before any
 * page JS runs. It patches the key fingerprinting vectors that bot detectors
 * probe during their first synchronous JS execution frame.
 *
 * Written as a self-contained IIFE so it has no dependencies on Node.js APIs
 * (it runs inside the browser sandbox).
 */
const STEALTH_SCRIPT = `
(function stealthPatch() {
  // ── 1. navigator.webdriver ─────────────────────────────────────────────────
  // The most checked signal. Chrome sets this to true in automation mode.
  // We delete the property and redefine it as a getter returning undefined.
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (_) {}

  // ── 2. navigator.plugins ──────────────────────────────────────────────────
  // Real Chrome has plugins; headless Chrome returns an empty PluginArray.
  // We fabricate a minimal but realistic-looking plugin list.
  try {
    const mockPlugin = (name, desc, filename, mimeTypes) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name:        { value: name,     enumerable: true },
        description: { value: desc,     enumerable: true },
        filename:    { value: filename, enumerable: true },
        length:      { value: mimeTypes.length, enumerable: true },
      });
      mimeTypes.forEach((mt, i) => {
        const mime = Object.create(MimeType.prototype);
        Object.defineProperties(mime, {
          type:        { value: mt.type,   enumerable: true },
          description: { value: mt.desc,   enumerable: true },
          suffixes:    { value: mt.suffix, enumerable: true },
        });
        Object.defineProperty(plugin, i, { value: mime, enumerable: true });
      });
      return plugin;
    };

    const plugins = [
      mockPlugin(
        'Chrome PDF Plugin',
        'Portable Document Format',
        'internal-pdf-viewer',
        [{ type: 'application/x-google-chrome-pdf', desc: 'Portable Document Format', suffix: 'pdf' }]
      ),
      mockPlugin(
        'Chrome PDF Viewer',
        '',
        'mhjfbmdgcfjbbpaeojofohoefgiehjai',
        [{ type: 'application/pdf', desc: '', suffix: 'pdf' }]
      ),
      mockPlugin(
        'Native Client',
        '',
        'internal-nacl-plugin',
        [
          { type: 'application/x-nacl',   desc: 'Native Client Executable', suffix: '' },
          { type: 'application/x-pnacl',  desc: 'Portable Native Client Executable', suffix: '' },
        ]
      ),
    ];

    const pluginArray = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) => Object.defineProperty(pluginArray, i, { value: p, enumerable: true }));
    Object.defineProperty(pluginArray, 'length', { value: plugins.length });
    Object.defineProperty(pluginArray, 'item', { value: (i) => plugins[i] });
    Object.defineProperty(pluginArray, 'namedItem', { value: (n) => plugins.find(p => p.name === n) || null });
    Object.defineProperty(navigator, 'plugins', { get: () => pluginArray, configurable: true });
  } catch (_) {}

  // ── 3. navigator.languages ────────────────────────────────────────────────
  // Headless Chrome often returns [] or a wrong locale.
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
  } catch (_) {}

  // ── 4. window.chrome ──────────────────────────────────────────────────────
  // Real Chrome exposes window.chrome with a runtime object.
  // Headless Chrome does not. Many bot detectors check window.chrome.runtime.
  try {
    if (!window.chrome) {
      const chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        runtime: {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', GC_PRESSURE: 'gc_pressure', OS_UPDATE: 'os_update' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        },
      };
      window.chrome = chrome;
    }
  } catch (_) {}

  // ── 5. WebGL vendor & renderer ────────────────────────────────────────────
  // Headless Chrome returns 'Google Inc.' and 'ANGLE (...)' which are
  // well-known automation signatures. We replace them with Apple / Intel
  // strings that match a real Mac laptop.
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';                        // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';          // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    };
    // Also patch WebGL2 if available
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.call(this, parameter);
      };
    }
  } catch (_) {}

  // ── 6. permissions.query ──────────────────────────────────────────────────
  // Headless Chrome throws on permissions.query({ name: 'notifications' }).
  // Real Chrome returns { state: 'denied' }. Some bot detectors catch the throw.
  try {
    const originalQuery = window.navigator.permissions.query.bind(navigator.permissions);
    window.navigator.permissions.query = (parameters) => {
      if (parameters && parameters.name === 'notifications') {
        return Promise.resolve({ state: 'denied', onchange: null });
      }
      return originalQuery(parameters);
    };
  } catch (_) {}

  // ── 7. navigator.platform ─────────────────────────────────────────────────
  // Our UA string says Windows but headless Chrome's platform says 'Linux x86_64'.
  // Detectors cross-check these two. We align them.
  try {
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
      configurable: true,
    });
  } catch (_) {}
})();
`;

/**
 * The User Agent to use for all browser contexts.
 * Must be a clean, real-looking Windows Chrome UA — no custom suffixes.
 * The 'SemanticProxy/1.0' tag previously in the UA was a detection signal.
 */
const STEALTH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * launchLeanBrowser
 *
 * Spins up one Chromium process configured for absolute minimum RAM usage,
 * then injects stealth patches into every page context before any page JS runs.
 * The returned context already has network-level blocking applied so callers
 * never need to think about asset interception themselves.
 */
export async function launchLeanBrowser(): Promise<BrowserBundle> {
  const launchOptions = {
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

      // ── Stealth: avoid 'Chrome is being controlled' infobar ─────────────
      '--disable-infobars',
      '--disable-blink-features=AutomationControlled',
    ],
  };

  let browser: Browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (err: any) {
    if (
      err.message &&
      (err.message.includes("Executable doesn't exist") ||
        err.message.includes("playwright install") ||
        err.message.includes("Looks like Playwright was just installed"))
    ) {
      console.warn('[browser] Chromium executable not found. Running self-healing playwright installation...');
      try {
        execSync('npx playwright install chromium', {
          stdio: 'inherit',
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright',
          },
        });
        console.info('[browser] Self-healing playwright installation complete. Retrying launch...');
        browser = await chromium.launch(launchOptions);
      } catch (installErr: any) {
        console.error('[browser] Self-healing installation failed:', installErr);
        throw err;
      }
    } else {
      throw err;
    }
  }

  // Isolated browser context: no cookies, no cache, no persistent storage.
  const context = await browser.newContext({
    userAgent: STEALTH_USER_AGENT,
    // A realistic 1920×1080 viewport. Headless browsers with tiny viewports
    // (e.g. 800×600) are a detection signal. We use a common desktop size.
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: true,
    storageState: undefined,
    // Locale & timezone aligned with our UA (US English, Eastern Time)
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // ── Stealth: inject patches before any page JS runs ────────────────────────
  // addInitScript runs before document.readyState === 'loading', so detectors
  // that run in DOMContentLoaded or earlier will see the patched values.
  await context.addInitScript(STEALTH_SCRIPT);
  console.log('[browser] Stealth init scripts injected into context');

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
