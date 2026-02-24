# Use Bun's official Docker image
FROM oven/bun:1-debian

# Set working directory
WORKDIR /app

# Install system dependencies needed for native modules
RUN apt-get update && apt-get install -y \
    # For better-sqlite3
    build-essential \
    python3 \
    # For ripgrep
    ripgrep \
    # For git
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json bun.lock ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY backend ./backend
COPY shared ./shared
COPY frontend ./frontend
COPY koryphaios.json ./
COPY .env.example ./

# Build the application
ENV NODE_ENV=production
RUN bun run build

# Create non-root user for security
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser

# Set ownership
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose ports
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health/ready || exit 1

# Start the server
CMD ["bun", "run", "backend/build/server.js"]
