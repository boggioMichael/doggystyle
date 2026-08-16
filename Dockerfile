FROM node:22-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install runtime dependencies for the workspaces. The build artifacts are copied
# from the local workspace build that is included in the Fly build context.
RUN npm ci --omit=dev --ignore-scripts

COPY packages/shared/dist ./packages/shared/dist
COPY apps/api/dist ./apps/api/dist
COPY apps/api/drizzle ./apps/api/drizzle
COPY apps/web/dist ./apps/web/dist

ENV NODE_ENV=production \
    SERVE_WEB=true \
    WEB_DIST_DIR=/app/apps/web/dist \
    HOST=0.0.0.0 \
    API_PORT=8080 \
    LOG_PRETTY=false \
    COOKIE_SECURE=true \
    DEMO_MODE=false

EXPOSE 8080

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/index.js"]
