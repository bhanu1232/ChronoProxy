/**
 * pruner.ts — Streaming Semantic DOM Pruner
 *
 * The intellectual core of the proxy. Implements a Node.js Transform stream
 * that consumes raw HTML chunks and emits ONLY semantically actionable tokens,
 * discarding all structural/presentational markup immediately.
 *
 * Memory Model: O(1) — only ONE element's data lives in memory at any time.
 * The moment a closing tag is detected the token is pushed downstream and the
 * elementBuffer is reset to the empty string, releasing the reference for GC.
 *
 * Throughput: A 10MB HTML page streams through in ~64KB slices; peak heap
 * pressure is bounded by: MAX(64KB chunk + ~256 bytes per token buffer).
 */

import { Parser } from 'htmlparser2';
import { Transform, TransformCallback } from 'stream';

/** Tags considered "interactive" (agent-actionable) */
const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'a']);

/** Max length of visible text we capture per element (prevents runaway buffers) */
const MAX_TEXT_CAPTURE = 120;

/** Emit a compact token line for the AI agent */
function formatToken(
  shortId: number,
  name: string,
  attribs: Record<string, string>,
  text: string,
): string {
  const type        = attribs['type']       || '';
  const placeholder = attribs['placeholder'] || '';
  const ariaLabel   = attribs['aria-label'] || attribs['aria-labelledby'] || '';
  const href        = attribs['href']       || '';
  const role        = attribs['role']       || '';
  const value       = attribs['value']      || '';
  const name_attr   = attribs['name']       || '';

  // Build a compact attribute string — only non-empty values are included
  // to keep token size minimal (important for downstream LLM context windows).
  const attrParts: string[] = [];
  if (type)        attrParts.push(`type="${type}"`);
  if (placeholder) attrParts.push(`placeholder="${placeholder}"`);
  if (ariaLabel)   attrParts.push(`aria-label="${ariaLabel}"`);
  if (href && href !== '#') attrParts.push(`href="${href}"`);
  if (role)        attrParts.push(`role="${role}"`);
  if (value)       attrParts.push(`value="${value}"`);
  if (name_attr)   attrParts.push(`name="${name_attr}"`);

  const attrStr = attrParts.length ? ' ' + attrParts.join(' ') : '';
  const textStr = text.trim().slice(0, MAX_TEXT_CAPTURE);

  return `[#${shortId}] <${name}${attrStr}>${textStr}</${name}>\n`;
}

/**
 * SemanticPrunerStream
 *
 * Usage:
 *   const pruner = new SemanticPrunerStream();
 *   htmlReadableStream.pipe(pruner).pipe(response);
 *
 * Output (text/plain, one line per interactive element):
 *   [#0] <a href="/login">Sign In</a>
 *   [#1] <input type="email" placeholder="Email address" name="email"></input>
 *   [#2] <button type="submit">Log In</button>
 */
export class SemanticPrunerStream extends Transform {
  private readonly parser: Parser;

  // ── Per-element ephemeral state (reset after every closing tag) ───────────
  private currentTag: string       = '';
  private currentAttribs: Record<string, string> = {};
  private isInteractive: boolean   = false;
  private elementBuffer: string    = '';          // O(1): cleared on close-tag
  private nestDepth: number        = 0;           // Track nested interactive tags

  // ── Global monotonic counter (session-scoped short ID) ───────────────────
  private elementCounter: number   = 0;

  // ── Streaming stats (exposed via getStats()) ─────────────────────────────
  private bytesIn: number          = 0;
  private tokensEmitted: number    = 0;
  private chunksProcessed: number  = 0;

  constructor() {
    // objectMode: false — we emit raw Buffer/string chunks, not JS objects.
    // highWaterMark: 16 elements in the readable buffer before backpressure.
    super({ readableObjectMode: false, writableObjectMode: false, highWaterMark: 16 });

    this.parser = new Parser(
      {
        // ── onopentag ────────────────────────────────────────────────────────
        onopentag: (name: string, attribs: Record<string, string>) => {
          const isInteractiveTag = INTERACTIVE_TAGS.has(name);
          const hasInteractiveRole =
            attribs['onclick'] !== undefined ||
            attribs['role'] === 'button'     ||
            attribs['role'] === 'link'       ||
            attribs['tabindex'] !== undefined;

          if (isInteractiveTag || hasInteractiveRole) {
            if (!this.isInteractive) {
              // Outermost interactive element — start capturing
              this.isInteractive  = true;
              this.currentTag     = name;
              this.currentAttribs = attribs;
              this.nestDepth      = 1;
              this.elementBuffer  = ''; // already empty, but explicit is clear
            } else {
              // Nested interactive element inside another (e.g., <a><button>)
              this.nestDepth++;
            }
          } else if (this.isInteractive) {
            this.nestDepth++;
          }
        },

        // ── ontext ───────────────────────────────────────────────────────────
        ontext: (text: string) => {
          if (!this.isInteractive) return;
          const trimmed = text.replace(/\s+/g, ' ').trim();
          if (!trimmed) return;
          // Guard: never let elementBuffer exceed a safe ceiling
          const remaining = MAX_TEXT_CAPTURE - this.elementBuffer.length;
          if (remaining > 0) {
            this.elementBuffer += trimmed.slice(0, remaining);
          }
        },

        // ── onclosetag ───────────────────────────────────────────────────────
        onclosetag: (name: string) => {
          if (!this.isInteractive) return;

          this.nestDepth--;

          if (this.nestDepth === 0 && name === this.currentTag) {
            // Emit the complete token and immediately free the buffer
            const token = formatToken(
              this.elementCounter++,
              this.currentTag,
              this.currentAttribs,
              this.elementBuffer,
            );
            this.push(token);
            this.tokensEmitted++;

            // ── O(1) Memory Release ─────────────────────────────────────────
            this.elementBuffer  = '';
            this.currentTag     = '';
            this.currentAttribs = {};
            this.isInteractive  = false;
            this.nestDepth      = 0;
          }
        },

        // ── onerror ──────────────────────────────────────────────────────────
        onerror: (err: Error) => {
          // htmlparser2 is lenient by design; surface errors as stream warnings
          // without aborting — malformed HTML is extremely common in the wild.
          this.emit('warning', `Parser warning: ${err.message}`);
        },
      },
      {
        decodeEntities: true,
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
      },
    );
  }

  /**
   * _transform — called for every incoming chunk.
   * We write to the parser immediately and call callback() right away,
   * so the upstream can continue sending the next chunk without waiting
   * for the downstream consumer to drain. True backpressure is handled
   * by Node's stream infrastructure via the highWaterMark.
   */
  _transform(chunk: Buffer | string, _encoding: string, callback: TransformCallback): void {
    const data = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    this.bytesIn += data.length;
    this.chunksProcessed++;
    this.parser.write(data);
    callback();
  }

  /**
   * _flush — called once when the writable side ends.
   * We finalize the parser so it can emit any pending close-tag events.
   */
  _flush(callback: TransformCallback): void {
    this.parser.end();
    callback();
  }

  /** Expose runtime telemetry without locking any internal state. */
  getStats(): {
    bytesIn: number;
    tokensEmitted: number;
    chunksProcessed: number;
    elementCounter: number;
    compressionRatio: string;
  } {
    const ratio =
      this.bytesIn > 0
        ? ((this.tokensEmitted * 80) / this.bytesIn * 100).toFixed(1)
        : '0.0';
    return {
      bytesIn: this.bytesIn,
      tokensEmitted: this.tokensEmitted,
      chunksProcessed: this.chunksProcessed,
      elementCounter: this.elementCounter,
      compressionRatio: `${ratio}%`,
    };
  }
}
