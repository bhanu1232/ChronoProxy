/**
 * session.ts — Persistent Browser Session Manager
 *
 * Manages long-lived browser sessions for AI agents that need to:
 *   - Navigate across multiple pages without re-launching Chromium
 *   - Maintain cookies/auth state across requests
 *   - Perform sequential actions (search → read results → click → read page)
 *
 * Architecture:
 *   - One shared Browser process for all sessions (memory-efficient)
 *   - Each session gets an isolated BrowserContext (own cookies, storage, etc.)
 *   - Sessions auto-expire after TTL_MS of inactivity (default: 10 minutes)
 *   - Max concurrent sessions = MAX_SESSIONS env var (default: 4)
 */

import { randomUUID } from 'crypto';
import { Browser, BrowserContext, Page } from 'playwright';
import { launchLeanBrowser } from './browser';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Session {
  id:             string;
  page:           Page;
  context:        BrowserContext;
  createdAt:      number;
  lastActivityAt: number;
  currentUrl:     string;
}

// ── Configuration ─────────────────────────────────────────────────────────────

const TTL_MS      = parseInt(process.env['SESSION_TTL_MS']  ?? String(10 * 60 * 1000), 10); // 10 min
const MAX_SESSIONS = parseInt(process.env['MAX_SESSIONS']   ?? '4', 10);

// ── Session Manager ───────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private browser:  Browser | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Start the TTL cleanup timer.
   * Call once at server startup.
   */
  start(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.sweepExpired(), 60_000);
    (this.cleanupInterval as NodeJS.Timeout).unref?.();
    console.log(`[session] Manager started — TTL=${TTL_MS / 1000}s, max=${MAX_SESSIONS} sessions`);
  }

  /** Stop the cleanup timer and close all sessions. */
  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.closeAll();
  }

  /** Returns count of active sessions. */
  get count(): number { return this.sessions.size; }

  /** Returns a read-only snapshot of all sessions (for health/metrics). */
  list(): Array<{ id: string; url: string; createdAt: number; lastActivityAt: number }> {
    return Array.from(this.sessions.values()).map(s => ({
      id:             s.id,
      url:            s.currentUrl,
      createdAt:      s.createdAt,
      lastActivityAt: s.lastActivityAt,
    }));
  }

  /**
   * Create a new session. Launches a browser if none is running.
   * Navigates to the given URL before returning.
   */
  async create(url: string, waitUntil: 'commit'|'domcontentloaded'|'load'|'networkidle' = 'domcontentloaded'): Promise<Session> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Session limit reached (max ${MAX_SESSIONS}). Close an existing session first.`);
    }

    // Ensure we have a running browser
    if (!this.browser || !this.browser.isConnected()) {
      console.log('[session] Launching session browser...');
      const bundle = await launchLeanBrowser();
      this.browser = bundle.browser;
      // Close the auto-created context from launchLeanBrowser — we'll create per-session ones
      await bundle.context.close().catch(() => undefined);
    }

    // Isolated context per session (own cookies, localStorage, network state)
    const context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36 ChronoProxy/2.0',
      viewport:          { width: 1280, height: 800 },
      javaScriptEnabled: true,
    });

    const page = await context.newPage();

    // Navigate to starting URL
    const timeout = parseInt(process.env['BROWSER_TIMEOUT_MS'] ?? '30000', 10);
    await page.goto(url, { waitUntil, timeout });

    const now     = Date.now();
    const session: Session = {
      id:             randomUUID(),
      page,
      context,
      createdAt:      now,
      lastActivityAt: now,
      currentUrl:     page.url(),
    };

    this.sessions.set(session.id, session);
    console.log(`[session] Created ${session.id} → ${url}`);
    return session;
  }

  /**
   * Retrieve an active session by ID.
   * Throws 404-style error if not found or expired.
   */
  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (Date.now() - session.lastActivityAt > TTL_MS) {
      void this.destroy(id);
      throw new Error(`Session expired: ${id}`);
    }
    return session;
  }

  /** Touch a session's lastActivityAt timestamp (call after every action). */
  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      s.lastActivityAt = Date.now();
      s.currentUrl     = s.page.url();
    }
  }

  /** Close a single session and release its context. */
  async destroy(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    try {
      await session.page.close().catch(() => undefined);
      await session.context.close().catch(() => undefined);
    } catch { /* ignore */ }
    console.log(`[session] Destroyed ${id}`);

    // If no sessions remain, close the browser to free RAM
    if (this.sessions.size === 0 && this.browser?.isConnected()) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      console.log('[session] Browser closed (no active sessions)');
    }

    return true;
  }

  /** Close every active session. */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map(id => this.destroy(id)));
  }

  /** Remove sessions that have exceeded their TTL. */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > TTL_MS) {
        console.log(`[session] Expiring idle session ${id}`);
        void this.destroy(id);
      }
    }
  }
}

/** Singleton — shared across the whole server process. */
export const sessionManager = new SessionManager();
