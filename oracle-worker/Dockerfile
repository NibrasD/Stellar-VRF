FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy built output and production deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

EXPOSE 8080

CMD ["node", "dist/index.js"]
