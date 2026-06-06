/**
 * extractor.ts — Structured Page State Extractor
 *
 * Extracts a rich, structured snapshot of a Playwright Page that AI agents
 * can process directly — no screenshots, no vision tokens.
 *
 * Output includes: URL, title, plain text, headings, links, buttons,
 * input fields, select dropdowns, and tables — each with a CSS selector
 * the agent can pass back to /v1/session/:id/action to interact with.
 *
 * v2.1 additions:
 *  - Shadow DOM piercing: recursively enters element.shadowRoot to extract
 *    inputs and buttons hidden inside Web Components (Salesforce, SAP Fiori, etc.)
 *  - Heuristic interactive tagging: detects React/Vue onClick divs/spans via
 *    cursor:pointer CSS + ARIA roles, tagged with heuristic:true so agents can
 *    distinguish reliable vs best-effort selectors.
 */

import { Page } from 'playwright';

export interface Heading    { level: string; text: string }
export interface Link       { text: string; href: string; selector: string }
export interface Button {
  text:      string;
  selector:  string;
  type:      string;
  disabled:  boolean;
  inShadow?: boolean;   // true if element lives inside a Shadow DOM subtree
  heuristic?: boolean;  // true if detected via cursor:pointer/ARIA (not a real <button>)
}
export interface InputField {
  name:      string;
  type:      string;
  placeholder: string;
  value:     string;
  label:     string;
  required:  boolean;
  selector:  string;
  inShadow?: boolean;   // true if element lives inside a Shadow DOM subtree
}
export interface SelectField {
  name: string; value: string; label: string;
  options: { value: string; text: string }[];
  selector: string;
}
export interface TableData   { headers: string[]; rows: string[][] }

export interface PageState {
  url:      string;
  title:    string;
  text:     string;        // cleaned plain-text body content
  headings: Heading[];
  links:    Link[];
  buttons:  Button[];
  inputs:   InputField[];
  selects:  SelectField[];
  tables:   TableData[];
}

/**
 * extractPageState
 *
 * Runs a single page.evaluate() call to extract all interactive and
 * semantic elements in one round-trip. Safe to call on any page.
 * Now recursively pierces Shadow DOM boundaries and detects heuristic
 * interactive elements.
 */
export async function extractPageState(page: Page): Promise<PageState> {
  const url   = page.url();
  const title = await page.title().catch(() => '');

  const extracted = await page.evaluate((): Omit<PageState, 'url' | 'title'> => {

    // ── Stable CSS selector builder ────────────────────────────────────────
    function buildSelector(el: Element, hostSelector?: string): string {
      // 1. id attribute (most stable)
      if (el.id) {
        const sel = `#${el.id}`;
        return hostSelector ? `${hostSelector} >>> ${sel}` : sel;
      }

      // 2. data-testid (test-friendly)
      const tid = (el as HTMLElement).dataset?.testid;
      if (tid) {
        const sel = `[data-testid="${tid}"]`;
        return hostSelector ? `${hostSelector} >>> ${sel}` : sel;
      }

      // 3. name attribute (forms) — works for both input and textarea
      const name = (el as HTMLInputElement | HTMLTextAreaElement).name;
      if (name) {
        const sel = `${el.tagName.toLowerCase()}[name="${name}"]`;
        return hostSelector ? `${hostSelector} >>> ${sel}` : sel;
      }

      // 4. aria-label (accessibility)
      const aria = el.getAttribute('aria-label');
      if (aria) {
        const sel = `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        return hostSelector ? `${hostSelector} >>> ${sel}` : sel;
      }

      // 5. nth-child path fallback
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
        const parent: Element | null = cur.parentElement;
        if (!parent) break;
        const idx = Array.from(parent.children).indexOf(cur) + 1;
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
        cur = parent;
      }
      const localSel = parts.length ? parts.join(' > ') : el.tagName.toLowerCase();
      return hostSelector ? `${hostSelector} >>> ${localSel}` : localSel;
    }

    // ── Label resolver ─────────────────────────────────────────────────────
    function resolveLabel(el: Element, root: Document | ShadowRoot = document): string {
      const id = (el as HTMLElement).id;
      if (id) {
        const lbl = root.querySelector(`label[for="${id}"]`);
        if (lbl) return (lbl.textContent ?? '').trim();
      }
      const aria = el.getAttribute('aria-label') ?? '';
      if (aria) return aria;
      const wrap = el.closest('label');
      if (wrap) return (wrap.textContent ?? '').replace((el as HTMLElement).innerText ?? '', '').trim();
      return '';
    }

    // ── Shadow DOM traversal ───────────────────────────────────────────────
    // Recursively collects interactive elements from both light DOM and
    // all shadow roots attached to custom elements.
    const SKIP_INPUT_TYPES = new Set(['hidden', 'button', 'submit', 'reset', 'image', 'file']);

    function traverseShadowRoot(
      root: Document | ShadowRoot,
      hostSelector?: string,
      inShadow: boolean = false,
      shadowButtons: Button[] = [],
      shadowInputs: InputField[] = [],
      shadowSelects: SelectField[] = [],
    ): void {
      // Collect inputs & textareas inside this root
      root.querySelectorAll('input, textarea').forEach((el) => {
        const inp = el as HTMLInputElement;
        if (SKIP_INPUT_TYPES.has(inp.type)) return;
        shadowInputs.push({
          name:        inp.name ?? '',
          type:        inp.type || (el.tagName === 'TEXTAREA' ? 'textarea' : 'text'),
          placeholder: inp.placeholder ?? '',
          value:       inp.value ?? '',
          label:       resolveLabel(el, root),
          required:    inp.required ?? false,
          selector:    buildSelector(el, hostSelector),
          inShadow,
        });
      });

      // Collect buttons inside this root
      root.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').forEach((el) => {
        const b = el as HTMLButtonElement;
        const text = ((b.textContent ?? '') || ((b as HTMLInputElement).value ?? '')).trim().slice(0, 80);
        if (!text) return;
        shadowButtons.push({
          text,
          selector: buildSelector(el, hostSelector),
          type:     b.type ?? 'button',
          disabled: b.disabled ?? false,
          inShadow,
        });
      });

      // Collect selects inside this root
      root.querySelectorAll('select').forEach((el) => {
        const s = el as HTMLSelectElement;
        shadowSelects.push({
          name:     s.name ?? '',
          value:    s.value,
          label:    resolveLabel(el, root),
          options:  Array.from(s.options).map(o => ({ value: o.value, text: o.text })),
          selector: buildSelector(el, hostSelector),
        });
      });

      // Recurse into any shadow roots found under custom elements
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) {
          // Build a selector path to this shadow host so we can prefix child selectors
          const hostSel = buildSelector(el, hostSelector);
          traverseShadowRoot(el.shadowRoot, hostSel, true, shadowButtons, shadowInputs, shadowSelects);
        }
      });
    }

    // ── Plain text ─────────────────────────────────────────────────────────
    const bodyClone = document.body.cloneNode(true) as HTMLElement;
    bodyClone.querySelectorAll('script,style,noscript,svg').forEach(n => n.remove());
    const text = (bodyClone.innerText ?? '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    // ── Headings ───────────────────────────────────────────────────────────
    const headings: Heading[] = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .map(h => ({ level: h.tagName.toLowerCase(), text: (h.textContent ?? '').trim() }))
      .filter(h => h.text.length > 0);

    // ── Links ──────────────────────────────────────────────────────────────
    const links: Link[] = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 150)
      .map(a => ({
        text:     (a.textContent ?? '').trim().slice(0, 100),
        href:     (a as HTMLAnchorElement).href,
        selector: buildSelector(a),
      }))
      .filter(l => l.text || l.href);

    // ── Buttons + Shadow DOM buttons ───────────────────────────────────────
    // Start with standard light-DOM buttons
    const shadowButtons: Button[] = [];
    const shadowInputs:  InputField[] = [];
    const shadowSelects: SelectField[] = [];

    // Collect standard light DOM buttons
    const lightButtons: Button[] = Array.from(
      document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]')
    ).map(b => ({
      text:     ((b.textContent ?? '') || ((b as HTMLInputElement).value ?? '')).trim().slice(0, 80),
      selector: buildSelector(b),
      type:     (b as HTMLButtonElement).type ?? 'button',
      disabled: (b as HTMLButtonElement).disabled ?? false,
    })).filter(b => b.text);

    // Collect standard light DOM inputs
    const lightInputs: InputField[] = Array.from(document.querySelectorAll('input, textarea'))
      .filter(i => !SKIP_INPUT_TYPES.has((i as HTMLInputElement).type))
      .map(i => ({
        name:        (i as HTMLInputElement).name ?? '',
        type:        (i as HTMLInputElement).type || (i.tagName === 'TEXTAREA' ? 'textarea' : 'text'),
        placeholder: (i as HTMLInputElement).placeholder ?? '',
        value:       (i as HTMLInputElement).value ?? '',
        label:       resolveLabel(i),
        required:    (i as HTMLInputElement).required ?? false,
        selector:    buildSelector(i),
      }));

    // Collect standard light DOM selects
    const lightSelects: SelectField[] = Array.from(document.querySelectorAll('select')).map(s => ({
      name:     (s as HTMLSelectElement).name ?? '',
      value:    (s as HTMLSelectElement).value,
      label:    resolveLabel(s),
      options:  Array.from((s as HTMLSelectElement).options).map(o => ({ value: o.value, text: o.text })),
      selector: buildSelector(s),
    }));

    // Now pierce Shadow DOM to find elements hidden in Web Components
    // We scan all elements in the light DOM looking for shadowRoot
    document.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) {
        const hostSel = buildSelector(el);
        traverseShadowRoot(el.shadowRoot, hostSel, true, shadowButtons, shadowInputs, shadowSelects);
      }
    });

    // Merge light + shadow results (shadow elements appended at end, tagged inShadow)
    const buttons = [...lightButtons, ...shadowButtons];
    const inputs  = [...lightInputs,  ...shadowInputs];
    const selects = [...lightSelects, ...shadowSelects];

    // ── Heuristic interactive element tagging ──────────────────────────────
    // Modern React/Vue/Angular apps attach onClick to <div>/<span> elements.
    // Standard querySelectorAll('button') misses these entirely.
    //
    // Strategy: scan all elements for two signals:
    //   1. computed style cursor === 'pointer'  (strongly suggests interactivity)
    //   2. role="button" attribute              (explicit ARIA semantics)
    //
    // Both must have visible non-empty text to be useful to an AI agent.
    // Already-captured elements are excluded via WeakSet deduplication.
    // Capped at 30 heuristic elements to avoid flooding the response.

    const STANDARD_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'OPTION']);
    const alreadyCaptured = new WeakSet<Element>();

    // Mark all standard-captured elements so we can skip them in heuristic pass
    document.querySelectorAll(
      'button, input[type="button"], input[type="submit"], [role="button"], a[href], input, textarea, select'
    ).forEach(el => alreadyCaptured.add(el));

    const heuristicButtons: Button[] = [];
    const allElements = Array.from(document.querySelectorAll('*')).slice(0, 2000); // cap for perf

    for (const el of allElements) {
      if (heuristicButtons.length >= 30) break;
      if (alreadyCaptured.has(el)) continue;
      if (STANDARD_TAGS.has(el.tagName)) continue;

      // Check visibility — skip hidden / off-screen elements
      const htmlEl = el as HTMLElement;
      if (htmlEl.offsetParent === null && htmlEl.style.position !== 'fixed') continue;

      const role   = el.getAttribute('role');
      const cursor = window.getComputedStyle(el).cursor;

      const isHeuristic = cursor === 'pointer' || role === 'button' || role === 'menuitem' || role === 'option';
      if (!isHeuristic) continue;

      const text = (htmlEl.textContent ?? '').trim().slice(0, 80);
      if (!text || text.length < 2) continue; // skip empty or single-char elements

      alreadyCaptured.add(el); // deduplicate in case this element appears again
      heuristicButtons.push({
        text,
        selector: buildSelector(el),
        type:     'button',
        disabled: (htmlEl as any).disabled ?? htmlEl.getAttribute('aria-disabled') === 'true',
        heuristic: true,
      });
    }

    // Merge heuristic buttons at the end so agents can distinguish them
    buttons.push(...heuristicButtons);

    // ── Tables ─────────────────────────────────────────────────────────────
    const tables: TableData[] = Array.from(document.querySelectorAll('table')).slice(0, 10).map(tbl => ({
      headers: Array.from(tbl.querySelectorAll('th')).map(th => (th.textContent ?? '').trim()),
      rows: Array.from(tbl.querySelectorAll('tr'))
        .map(tr => Array.from(tr.querySelectorAll('td')).map(td => (td.textContent ?? '').trim()))
        .filter(r => r.length > 0),
    }));

    return { text, headings, links, buttons, inputs, selects, tables };
  });

  return { url, title, ...extracted };
}
