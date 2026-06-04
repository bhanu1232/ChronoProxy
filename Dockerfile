# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Semantic Browser Proxy — Multi-stage Dockerfile                    ║
# ║  Target: node:20-slim + Playwright system deps                      ║
# ║  Final image size target: ~700MB (Chromium binary is unavoidable)   ║
# ╚══════════════════════════════════════════════════════════════════════╝

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy manifests first for layer-cache efficiency
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY src/ ./src/
RUN npm run build


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install Chromium system dependencies (Playwright downloads its own Chromium)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Copy production dependencies and compiled output
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Playwright Environment ────────────────────────────────────────────────────
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install Playwright browsers (Chromium only)
RUN mkdir -p /ms-playwright && \
    npx playwright install chromium --with-deps

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist
# Copy dashboard UI
COPY dashboard/ ./dashboard/

# ── Security: non-root user ───────────────────────────────────────────────────
RUN groupadd -r chronoproxy && useradd -r -g chronoproxy -G audio,video chronoproxy \
    && chown -R chronoproxy:chronoproxy /app /ms-playwright
USER chronoproxy

# ── Hard RAM cap via Node options ─────────────────────────────────────────────
ENV NODE_OPTIONS="--max-old-space-size=400"
ENV NODE_ENV="production"

EXPOSE 8080

# Graceful shutdown: Docker stop sends SIGTERM, our process handles it.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/v1/health || exit 1

CMD ["node", "dist/server.js"]
