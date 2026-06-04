/**
 * pool.ts — Browser Instance Concurrency Pool
 *
 * Manages a fixed-size queue of Playwright Browser instances to enforce the
 * 512MB RAM ceiling. At ~80–100MB per Chromium process, MAX_BROWSERS=4 leaves
 * a comfortable margin for the Node.js process itself (~80MB) and Redis/Postgres
 * client connections.
 *
 * Acquire/Release Model:
 *   - Callers call pool.acquire() and await a BrowserBundle.
 *   - If the pool is exhausted, the request is queued (not rejected immediately).
 *   - After use, callers MUST call pool.release(bundle) or pool.destroy(bundle).
 *   - pool.destroy() is used when the browser process is suspected to be broken
 *     (navigation error, timeout, OOM signal from Chromium).
 *
 * Pool Statistics are emitted on the EventEmitter channel 'stats' every second
 * so the WebSocket endpoint can forward them to the dashboard in real time.
 */

import { EventEmitter } from 'events';
import { BrowserBundle, launchLeanBrowser } from './browser';

export interface PoolStats {
  active: number;
  idle: number;
  queued: number;
  total: number;
  maxBrowsers: number;
  estimatedMemoryMB: number;
}

// Approximate per-browser RAM contribution (measured empirically).
const RAM_PER_BROWSER_MB = 95;
const NODE_BASE_RAM_MB   = 80;

interface QueueEntry {
  resolve: (bundle: BrowserBundle) => void;
  reject:  (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class BrowserPool extends EventEmitter {
  private readonly maxBrowsers: number;
  private readonly acquireTimeoutMs: number;
  private readonly idlePool: BrowserBundle[]  = [];   // Ready instances
  private readonly activeSet: Set<BrowserBundle>      = new Set(); // In-use instances
  private readonly waitQueue: QueueEntry[]    = [];   // Callers waiting for a slot

  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { maxBrowsers?: number; acquireTimeoutMs?: number }) {
    super();
    this.setMaxListeners(100);
    this.maxBrowsers      = options?.maxBrowsers      ?? parseInt(process.env['MAX_BROWSERS'] ?? '4', 10);
    this.acquireTimeoutMs = options?.acquireTimeoutMs ?? parseInt(process.env['BROWSER_TIMEOUT_MS'] ?? '15000', 10);
  }

  /** Start emitting stats on the given interval (ms). Default: 1 second. */
  startStatsEmitter(intervalMs = 1000): void {
    if (this.statsInterval) return;
    this.statsInterval = setInterval(() => {
      this.emit('stats', this.getStats());
    }, intervalMs);
    // Don't hold the process open just for telemetry
    (this.statsInterval as NodeJS.Timeout).unref?.();
  }

  stopStatsEmitter(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /** Total instantiated browsers (idle + active). */
  get total(): number {
    return this.idlePool.length + this.activeSet.size;
  }

  /**
   * Acquire a browser bundle. Returns immediately if an idle instance exists.
   * Launches a new instance if under the cap. Otherwise queues the request.
   */
  async acquire(): Promise<BrowserBundle> {
    // Fast path: reuse an idle instance
    if (this.idlePool.length > 0) {
      const bundle = this.idlePool.pop()!;
      this.activeSet.add(bundle);
      this.emit('stats', this.getStats());
      return bundle;
    }

    // Slow path: launch new if under cap
    if (this.total < this.maxBrowsers) {
      const bundle = await launchLeanBrowser();
      this.activeSet.add(bundle);
      this.emit('stats', this.getStats());
      return bundle;
    }

    // Queue path: wait for a release event
    return new Promise<BrowserBundle>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const idx = this.waitQueue.findIndex((e) => e.resolve === resolve);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(new Error(`BrowserPool: acquire timed out after ${this.acquireTimeoutMs}ms`));
      }, this.acquireTimeoutMs);

      this.waitQueue.push({ resolve, reject, timeoutHandle });
      this.emit('stats', this.getStats());
    });
  }

  /**
   * Return a healthy bundle to the idle pool.
   * If there are callers waiting, hand it off directly (zero re-launch cost).
   */
  release(bundle: BrowserBundle): void {
    if (!this.activeSet.delete(bundle)) return; // Not one of ours

    if (this.waitQueue.length > 0) {
      // Hand off immediately to the oldest waiting caller
      const entry = this.waitQueue.shift()!;
      clearTimeout(entry.timeoutHandle);
      this.activeSet.add(bundle);
      entry.resolve(bundle);
    } else {
      this.idlePool.push(bundle);
    }
    this.emit('stats', this.getStats());
  }

  /**
   * Destroy a bundle (suspected broken/OOM'd Chromium process).
   * Launches a fresh instance if there are callers waiting.
   */
  async destroy(bundle: BrowserBundle): Promise<void> {
    this.activeSet.delete(bundle);
    try {
      await bundle.context.close().catch(() => undefined);
      await bundle.browser.close().catch(() => undefined);
    } catch {
      // Ignore errors on a broken browser — we just want the process gone.
    }

    // Satisfy the queue with a freshly launched browser
    if (this.waitQueue.length > 0) {
      const entry = this.waitQueue.shift()!;
      clearTimeout(entry.timeoutHandle);
      launchLeanBrowser()
        .then((fresh) => {
          this.activeSet.add(fresh);
          entry.resolve(fresh);
        })
        .catch(entry.reject);
    }
    this.emit('stats', this.getStats());
  }

  /** Drain the pool: close all browsers and reject all waiting callers. */
  async drain(): Promise<void> {
    this.stopStatsEmitter();

    // Reject all queued waiters
    for (const entry of this.waitQueue.splice(0)) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(new Error('BrowserPool: pool is draining'));
    }

    // Close idle browsers
    const closures = [
      ...this.idlePool.splice(0).map((b) =>
        b.browser.close().catch(() => undefined),
      ),
      ...Array.from(this.activeSet).map((b) =>
        b.browser.close().catch(() => undefined),
      ),
    ];
    this.activeSet.clear();
    await Promise.all(closures);
  }

  getStats(): PoolStats {
    const active  = this.activeSet.size;
    const idle    = this.idlePool.length;
    const queued  = this.waitQueue.length;
    const total   = active + idle;
    const estimatedMemoryMB = Math.round(NODE_BASE_RAM_MB + total * RAM_PER_BROWSER_MB);

    return { active, idle, queued, total, maxBrowsers: this.maxBrowsers, estimatedMemoryMB };
  }
}

/** Singleton pool shared across the application. */
export const browserPool = new BrowserPool();
