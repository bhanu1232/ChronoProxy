# ═══════════════════════════════════════════════════════════════════════════════
#  ChronoProxy — Production Dockerfile
#  Build : docker build -t bhanu1232/chronoproxy:latest .
#  Run   : docker run --rm -p 8080:8080 bhanu1232/chronoproxy:latest
#  Test  : curl http://localhost:8080/v1/health
# ═══════════════════════════════════════════════════════════════════════════════

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Minimal tools needed before playwright installs its own deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production node modules only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Install Chromium headless shell + every system dependency it needs.
# --with-deps handles all apt packages automatically for this OS/arch.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN npx playwright install --with-deps chromium

# Application code (no dashboard)
COPY --from=builder /app/dist ./dist

# ── Environment defaults (all overridable at runtime) ─────────────────────────
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=350"
# PORT is injected by Render/Railway at runtime — default only used locally
ENV PORT=8080
ENV HOST=0.0.0.0
# 2 browsers × ~95 MB + ~120 MB Node ≈ 310 MB → safe on 512 MB hosts
ENV MAX_BROWSERS=2
ENV BROWSER_TIMEOUT_MS=30000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fs http://localhost:${PORT}/v1/health || exit 1

CMD ["node", "dist/server.js"]
