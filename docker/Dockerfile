# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Semantic Browser Proxy — Multi-stage Dockerfile                    ║
# ║  Base: mcr.microsoft.com/playwright:v1.44.1-jammy (Ubuntu 22.04)   ║
# ║  Playwright + all Chromium system deps pre-installed in base image  ║
# ╚══════════════════════════════════════════════════════════════════════╝

FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build


FROM mcr.microsoft.com/playwright:v1.44.1-jammy AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=builder /app/dist ./dist
COPY dashboard/ ./dashboard/

ENV NODE_OPTIONS="--max-old-space-size=400"
ENV NODE_ENV="production"
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD wget -qO- http://localhost:${PORT}/v1/health || exit 1

CMD ["node", "dist/server.js"]
