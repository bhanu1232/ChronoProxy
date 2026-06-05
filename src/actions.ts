/**
 * actions.ts — AI Agent Action Executor
 *
 * Executes an ordered list of browser actions on a Playwright Page.
 * Each action represents a single interaction an AI agent would take
 * instead of: take screenshot → analyze with vision → generate click coords.
 *
 * Supported actions:
 *   navigate    → go to a URL
 *   click       → click by CSS selector
 *   click_text  → click first element matching visible text
 *   type        → type text into an input (optionally clearing first)
 *   fill        → instantly fill a value (no keystroke simulation)
 *   press       → press a keyboard key (Enter, Tab, Escape, ArrowDown…)
 *   scroll      → scroll the page by pixels
 *   scroll_to   → scroll an element into view
 *   select      → pick an option from a <select> by value or label
 *   hover       → hover over an element (triggers hover menus)
 *   wait_for    → wait until a selector appears in DOM
 *   wait        → wait a fixed number of milliseconds
 *   clear       → clear the value of an input
 */

import { Page } from 'playwright';

// ── Action type union ─────────────────────────────────────────────────────────

export type Action =
  | { type: 'navigate';   url: string; waitUntil?: 'commit'|'domcontentloaded'|'load'|'networkidle' }
  | { type: 'click';      selector: string; timeout?: number }
  | { type: 'click_text'; text: string; exact?: boolean; timeout?: number }
  | { type: 'type';       selector: string; text: string; clear?: boolean; delay?: number }
  | { type: 'fill';       selector: string; value: string }
  | { type: 'press';      key: string; selector?: string }
  | { type: 'scroll';     x?: number; y?: number }
  | { type: 'scroll_to';  selector: string }
  | { type: 'select';     selector: string; value: string }
  | { type: 'hover';      selector: string; timeout?: number }
  | { type: 'wait_for';   selector: string; timeout?: number; state?: 'attached'|'visible'|'hidden'|'detached' }
  | { type: 'wait';       ms: number }
  | { type: 'clear';      selector: string };

export interface ActionResult {
  type:       string;
  ok:         boolean;
  durationMs: number;
  error?:     string;
}

const DEFAULT_TIMEOUT = parseInt(process.env['BROWSER_TIMEOUT_MS'] ?? '15000', 10);

/**
 * executeActions
 *
 * Runs each action in sequence. If an action fails, execution stops and
 * the error is returned in the results array. Callers receive partial
 * results so the AI agent can see how far it got.
 */
export async function executeActions(page: Page, actions: Action[]): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const action of actions) {
    const t0  = Date.now();
    let ok    = true;
    let error: string | undefined;

    try {
      await runAction(page, action);
    } catch (err: any) {
      ok    = false;
      error = err.message ?? String(err);
      results.push({ type: action.type, ok, durationMs: Date.now() - t0, error });
      // Stop on first failure so agent can inspect and retry
      break;
    }

    results.push({ type: action.type, ok, durationMs: Date.now() - t0 });
  }

  return results;
}

// ── Internal dispatcher ───────────────────────────────────────────────────────

async function runAction(page: Page, action: Action): Promise<void> {
  const timeout = ('timeout' in action && action.timeout) ? action.timeout : DEFAULT_TIMEOUT;

  switch (action.type) {

    case 'navigate':
      await page.goto(action.url, {
        waitUntil: action.waitUntil ?? 'domcontentloaded',
        timeout,
      });
      break;

    case 'click':
      await page.click(action.selector, { timeout });
      break;

    case 'click_text':
      await page
        .getByText(action.text, { exact: action.exact ?? false })
        .first()
        .click({ timeout });
      break;

    case 'type':
      if (action.clear) {
        await page.fill(action.selector, '');
      }
      await page.type(action.selector, action.text, {
        delay: action.delay ?? 20,   // slight delay simulates human typing
      });
      break;

    case 'fill':
      // Instantly sets value — useful for large text, no delay
      await page.fill(action.selector, action.value);
      break;

    case 'press':
      if (action.selector) {
        await page.press(action.selector, action.key);
      } else {
        await page.keyboard.press(action.key);
      }
      break;

    case 'scroll':
      await page.evaluate(
        ([x, y]: [number, number]) => window.scrollBy(x, y),
        [action.x ?? 0, action.y ?? 400] as [number, number],
      );
      break;

    case 'scroll_to':
      await page.locator(action.selector).scrollIntoViewIfNeeded({ timeout });
      break;

    case 'select':
      await page.selectOption(action.selector, action.value, { timeout });
      break;

    case 'hover':
      await page.hover(action.selector, { timeout });
      break;

    case 'wait_for':
      await page.waitForSelector(action.selector, {
        state:   action.state ?? 'visible',
        timeout: action.timeout ?? 10_000,
      });
      break;

    case 'wait':
      await page.waitForTimeout(Math.min(action.ms, 10_000)); // cap at 10s
      break;

    case 'clear':
      await page.fill(action.selector, '');
      break;

    default:
      throw new Error(`Unknown action type: ${(action as any).type}`);
  }
}
