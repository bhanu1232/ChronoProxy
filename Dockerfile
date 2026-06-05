# ═══════════════════════════════════════════════════════════════════════════════
#  ChronoProxy — Production Dockerfile
#  Base  : node:20-slim (Debian Bookworm, ~250 MB)
#  Final : ~600 MB (Node + Chromium headless shell + system libs)
#
#  Build : docker build -t chronoproxy .
#  Run   : docker run -p 8080:8080 -e PORT=8080 chronoproxy
# ═══════════════════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 · Builder — compile TypeScript → dist/
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install deps (all, including devDeps for tsc)
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript
COPY src/ ./src/
RUN npm run build


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 · Runtime — lean production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# ── System dependencies required by Chromium headless shell ──────────────────
# `--with-deps` in the playwright install step handles this automatically,
# but we pre-seed curl and ca-certs so the install can reach the internet.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Node production dependencies ──────────────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Playwright: install Chromium headless shell + all its system deps ─────────
# PLAYWRIGHT_BROWSERS_PATH tells Playwright where to store & find the browser.
# --with-deps automatically installs every required apt package on this OS.
# chromium installs the smaller headless-shell binary (not the full browser).
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN npx playwright install --with-deps chromium

# ── Application code ──────────────────────────────────────────────────────────
COPY --from=builder /app/dist ./dist

# ── Runtime environment ───────────────────────────────────────────────────────
ENV NODE_ENV=production
# Cap Node.js heap — leaves room for Chromium processes within 512 MB
ENV NODE_OPTIONS="--max-old-space-size=350"
# PORT / HOST — overridden at runtime by Render / Railway / Docker
ENV PORT=8080
ENV HOST=0.0.0.0
# Browser pool: 2 instances × ~95 MB = ~190 MB + ~120 MB Node = ~310 MB total
ENV MAX_BROWSERS=2
ENV BROWSER_TIMEOUT_MS=30000

EXPOSE 8080

# ── Health check ──────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fs http://localhost:${PORT}/v1/health || exit 1

CMD ["node", "dist/server.js"]
