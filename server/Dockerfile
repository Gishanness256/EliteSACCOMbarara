# ============================================================================
# Elite SACCO Mbarara — API server Dockerfile
# ----------------------------------------------------------------------------
# Multi-stage build producing a minimal, non-root Node.js runtime image
# ready for production hosting.
#
#   Stage 1 (deps)    — install ALL deps (including devDeps for build tools)
#   Stage 2 (release) — production deps only + app source + migrations
#
# Build:
#   docker build -t elite-sacco-api:1.0.0 .
#
# Run (example — adapt to your environment):
#   docker run -d --name sacco-api \
#     -p 4000:4000 \
#     --env-file .env \
#     -e DATABASE_URL=postgres://sacco:secret@db:5432/elite_sacco \
#     -v $(pwd)/logs:/app/logs \
#     -v $(pwd)/uploads:/app/uploads \
#     --restart unless-stopped \
#     elite-sacco-api:1.0.0
#
# The image auto-runs pending migrations on container start via the
# entrypoint script, then starts the Node.js server.
# ============================================================================

# ---------- Stage 1: dependencies -------------------------------------------
FROM node:20-bookworm-slim AS deps

# pg-native and argon2 need native build tools
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        libpq-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfiles first for better layer caching
COPY package.json package-lock.json* ./

# Install ALL dependencies (including devDependencies for build tools)
RUN npm config set fund false \
 && npm config set audit false \
 && npm ci --no-audit --no-fund --include=dev \
 && npm cache clean --force

# ---------- Stage 2: release (runtime) -------------------------------------
FROM node:20-bookworm-slim AS release

# Runtime labels for OCI compliance
LABEL org.opencontainers.image.title="Elite SACCO Mbarara API" \
      org.opencontainers.image.description="Backend service for Elite SACCO Mbarara — users, members, savings, loans, regulatory returns, and a tamper-evident audit log." \
      org.opencontainers.image.source="https://elitesacco.co.ug" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.authors="Gisha-Tech Innovations" \
      org.opencontainers.image.version="1.0.0"

# Install only runtime libs (libpq for pg-native, no build tools)
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        curl \
        tini \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && update-ca-certificates

# Create a non-root user to run the app
RUN groupadd --system --gid 1001 nodeapp \
 && useradd  --system --uid 1001 --gid nodeapp \
             --home-dir /app --shell /usr/sbin/nologin \
             --comment "Elite SACCO API runtime user" \
             nodeapp

WORKDIR /app

# Copy package manifests
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/package-lock.json* ./package-lock.json*

# Install PRODUCTION dependencies only (skips devDependencies)
RUN npm config set fund false \
 && npm config set audit false \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# Copy application source and migrations
COPY --chown=nodeapp:nodeapp src/      ./src/
COPY --chown=nodeapp:nodeapp migrations/ ./migrations/

# Copy the entrypoint script
COPY --chown=nodeapp:nodeapp docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create writable directories for logs and uploads
RUN mkdir -p /app/logs /app/uploads \
 && chown -R nodeapp:nodeapp /app

# Switch to the non-root user
USER nodeapp

# Expose the API port (matching default PORT in .env.example)
EXPOSE 4000

# Environment defaults (override at runtime via -e or --env-file)
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    PGSSLMODE=disable \
    NPM_CONFIG_LOGLEVEL=error \
    NPM_CONFIG_FUND=false

# Health check — hits the /health endpoint every 30s
# Fails after 3 consecutive failures (90s) → container marked unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --silent --fail --max-time 3 http://127.0.0.1:${PORT}/health || exit 1

# Use tini as PID 1 for proper signal forwarding (SIGTERM → graceful shutdown)
# Entrypoint runs migrations then execs the Node.js server
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# Default command — start the API server
CMD ["node", "src/server.js"]
