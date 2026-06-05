/**
 * extractor.ts — Structured Page State Extractor
 *
 * Extracts a rich, structured snapshot of a Playwright Page that AI agents
 * can process directly — no screenshots, no vision tokens.
 *
 * Output includes: URL, title, plain text, headings, links, buttons,
 * input fields, select dropdowns, and tables — each with a CSS selector
 * the agent can pass back to /v1/session/:id/action to interact with.
 */

import { Page } from 'playwright';

export interface Heading    { level: string; text: string }
export interface Link       { text: string; href: string; selector: string }
export interface Button     { text: string; selector: string; type: string; disabled: boolean }
export interface InputField {
  name: string; type: string; placeholder: string;
  value: string; label: string; required: boolean; selector: string;
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
 */
export async function extractPageState(page: Page): Promise<PageState> {
  const url   = page.url();
  const title = await page.title().catch(() => '');

  const extracted = await page.evaluate((): Omit<PageState, 'url' | 'title'> => {
    // ── Stable CSS selector builder ────────────────────────────────────────
    function buildSelector(el: Element): string {
      // 1. id attribute (most stable)
      if (el.id) return `#${el.id}`;

      // 2. data-testid (test-friendly)
      const tid = (el as HTMLElement).dataset.testid;
      if (tid) return `[data-testid="${tid}"]`;

      // 3. name attribute (forms)
      const name = (el as HTMLInputElement).name;
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;

      // 4. aria-label (accessibility)
      const aria = el.getAttribute('aria-label');
      if (aria) return `[aria-label="${aria.replace(/"/g, '\\"')}"]`;

      // 5. Unique text + tag combo for links and buttons
      const text = (el.textContent ?? '').trim().slice(0, 40);
      if (text && ['A', 'BUTTON'].includes(el.tagName)) {
        const tag   = el.tagName.toLowerCase();
        const all   = Array.from(document.querySelectorAll(tag));
        const match = all.filter(e => e.textContent?.trim().startsWith(text));
        if (match.length === 1) return `${tag}:has-text-approx`;
      }

      // 6. nth-child path fallback
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
        const parent: Element | null = cur.parentElement;
        if (!parent) break;
        const idx = Array.from(parent.children).indexOf(cur) + 1;
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
        cur = parent;
      }
      return parts.length ? parts.join(' > ') : el.tagName.toLowerCase();
    }

    // ── Label resolver ─────────────────────────────────────────────────────
    function resolveLabel(el: Element): string {
      const id = el.id;
      if (id) {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl) return (lbl.textContent ?? '').trim();
      }
      const aria = el.getAttribute('aria-label') ?? '';
      if (aria) return aria;
      const wrap = el.closest('label');
      if (wrap) return (wrap.textContent ?? '').replace((el as HTMLElement).innerText ?? '', '').trim();
      return '';
    }

    // ── Plain text ─────────────────────────────────────────────────────────
    // Clone body, remove scripts/styles, get innerText
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

    // ── Buttons ────────────────────────────────────────────────────────────
    const buttons: Button[] = Array.from(
      document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]')
    ).map(b => ({
      text:     ((b.textContent ?? '') || ((b as HTMLInputElement).value ?? '')).trim().slice(0, 80),
      selector: buildSelector(b),
      type:     (b as HTMLButtonElement).type ?? 'button',
      disabled: (b as HTMLButtonElement).disabled ?? false,
    })).filter(b => b.text);

    // ── Inputs ─────────────────────────────────────────────────────────────
    const SKIP = new Set(['hidden', 'button', 'submit', 'reset', 'image']);
    const inputs: InputField[] = Array.from(document.querySelectorAll('input, textarea'))
      .filter(i => !SKIP.has((i as HTMLInputElement).type))
      .map(i => ({
        name:        (i as HTMLInputElement).name ?? '',
        type:        (i as HTMLInputElement).type || (i.tagName === 'TEXTAREA' ? 'textarea' : 'text'),
        placeholder: (i as HTMLInputElement).placeholder ?? '',
        value:       (i as HTMLInputElement).value ?? '',
        label:       resolveLabel(i),
        required:    (i as HTMLInputElement).required ?? false,
        selector:    buildSelector(i),
      }));

    // ── Selects ────────────────────────────────────────────────────────────
    const selects: SelectField[] = Array.from(document.querySelectorAll('select')).map(s => ({
      name:     (s as HTMLSelectElement).name ?? '',
      value:    (s as HTMLSelectElement).value,
      label:    resolveLabel(s),
      options:  Array.from((s as HTMLSelectElement).options).map(o => ({ value: o.value, text: o.text })),
      selector: buildSelector(s),
    }));

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
