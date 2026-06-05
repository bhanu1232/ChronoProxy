# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Semantic Browser Proxy — Multi-stage Dockerfile                    ║
# ║  Base: mcr.microsoft.com/playwright:v1.44.1-jammy (Ubuntu 22.04)   ║
# ║  Playwright + all Chromium system deps pre-installed in base image  ║
# ╚══════════════════════════════════════════════════════════════════════╝

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# The official Playwright image ships with Chromium + ALL system dependencies.
# Running as root is fine here because we use --no-sandbox in browser.ts.
FROM mcr.microsoft.com/playwright:v1.44.1-jammy AS runtime

WORKDIR /app

# Install production node dependencies only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Browsers are pre-installed in /ms-playwright inside the base image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy compiled app and dashboard from builder stage
COPY --from=builder /app/dist ./dist
COPY dashboard/ ./dashboard/

# ── Runtime environment ───────────────────────────────────────────────────────
ENV NODE_OPTIONS="--max-old-space-size=400"
ENV NODE_ENV="production"
# PORT and HOST are set here as defaults; Render overrides PORT at runtime
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

STOPSIGNAL SIGTERM

# Health check — wget is available in the playwright base image
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD wget -qO- http://localhost:${PORT}/v1/health || exit 1

CMD ["node", "dist/server.js"]
