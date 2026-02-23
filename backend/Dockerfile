# Koryphaios Backend Dockerfile
# Multi-stage build for production

# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY backend ./backend
COPY shared ./shared

# Build the application
WORKDIR /app/backend
RUN bun run build

# ─── Stage 2: Production ─────────────────────────────────────────────────────
FROM oven/bun:1-slim AS production

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r koryphaios && useradd -r -g koryphaios koryphaios

# Copy built application
COPY --from=builder /app/backend/build ./
COPY --from=builder /app/backend/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/node_modules ./node_modules

# Create data directory
RUN mkdir -p /data && chown -R koryphaios:koryphaios /data

# Switch to non-root user
USER koryphaios

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["bun", "run", "server.js"]
