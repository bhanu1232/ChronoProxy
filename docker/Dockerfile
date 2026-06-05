# ═══════════════════════════════════════════════════════════════════════════════
#  ChronoProxy — Production Dockerfile (docker/ variant for local compose)
#  Same as root Dockerfile — kept in sync manually.
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build


FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN npx playwright install --with-deps chromium

COPY --from=builder /app/dist ./dist
COPY dashboard/ ./dashboard/

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=350"
ENV PORT=8080
ENV HOST=0.0.0.0
ENV MAX_BROWSERS=2
ENV BROWSER_TIMEOUT_MS=30000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fs http://localhost:${PORT}/v1/health || exit 1

CMD ["node", "dist/server.js"]
