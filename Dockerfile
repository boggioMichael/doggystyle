# ─── Stage 1: Build shared package and API ────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm ci --ignore-scripts

# Copy all source
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY tsconfig.base.json ./

# Build shared (compiled JS needed by API at runtime via NodeNext resolution)
RUN npx tsc -p packages/shared/tsconfig.json

# Build API
RUN npx tsc -p apps/api/tsconfig.json

# Build Web SPA (Vite — no tsc emit needed, bundler handles it)
RUN npx vite build --config apps/web/vite.config.ts

# ─── Stage 2: Production image ────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy only production manifests and install prod deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Skip scripts (sharp native build, etc.) — already handled at build time
RUN npm ci --omit=dev --ignore-scripts --workspace=packages/shared --workspace=apps/api

# Copy compiled artefacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/api/dist         ./apps/api/dist

# Copy web SPA — served by Fastify as static files (SERVE_WEB=true)
COPY --from=builder /app/apps/web/dist         ./apps/web/dist

# Drizzle migrations (needed at startup)
COPY apps/api/drizzle ./apps/api/drizzle

# Drop root, run as node user
USER node

ENV NODE_ENV=production \
    SERVE_WEB=true \
    WEB_DIST_DIR=/app/apps/web/dist \
    HOST=0.0.0.0 \
    API_PORT=8080 \
    LOG_PRETTY=false \
    COOKIE_SECURE=true \
    DEMO_MODE=false

EXPOSE 8080

# dumb-init forwards signals correctly so graceful shutdown works
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/index.js"]
