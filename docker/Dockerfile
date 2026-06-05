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
# Use the official Playwright image — Chromium + all system deps are pre-baked.
FROM mcr.microsoft.com/playwright:v1.44.1-jammy AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=builder /app/dist ./dist
COPY dashboard/ ./dashboard/

RUN chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_OPTIONS="--max-old-space-size=400"
ENV NODE_ENV="production"
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/v1/health || exit 1

CMD ["node", "dist/server.js"]
