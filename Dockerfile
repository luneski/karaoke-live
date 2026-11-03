# Stage 1: Build & compile native dependencies
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Stage 2: Minimal production runtime image
FROM node:22-alpine

WORKDIR /app

# Set default production environment
ENV NODE_ENV=production \
    PORT=3030 \
    DB_PATH=/app/data/karaoke.db

# Remove npm, npx, corepack & yarn to eliminate unused tooling and reduce attack surface
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*

# Ensure /app/data directory exists and belongs to non-root user 'node' (uid 1000)
RUN mkdir -p /app/data && chown -R node:node /app

# Copy compiled production node_modules from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy application code
COPY --chown=node:node package*.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data

# Switch to non-root user
USER node

EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3030/health || exit 1

VOLUME ["/app/data"]

CMD ["node", "server.js"]
