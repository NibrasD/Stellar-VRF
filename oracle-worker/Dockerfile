FROM node:22-alpine AS builder

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
# Node 22 is required: @stellar/stellar-sdk v17 declares "engines.node": ">=22.12.0".
FROM node:22-alpine

WORKDIR /app

# Production image: makes the worker refuse unsafe debug settings
# (e.g. DRAND_VERIFY_BEACONS=false) at startup — see src/policy.ts.
ENV NODE_ENV=production

# Copy built output and production deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

EXPOSE 8080

USER node

CMD ["node", "dist/index.js"]
