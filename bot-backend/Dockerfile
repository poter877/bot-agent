# Build stage: compile TypeScript and prune to production dependencies while
# the toolchain is still available. Pin the exact patch AND the image digest
# at adoption (docker pull, then replace the tag with @sha256:<digest> from
# `docker images --digests`).
FROM node:24-bookworm-slim AS build
WORKDIR /app
# The slim image ships no toolchain; native deps in the lockfile compile from
# source (`make: not found` otherwise). It stays in THIS stage only.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.drama.json ./
COPY src ./src
# 主工程 + drama 子工程（独立严格度）双编译，输出合并到 dist/（app.js 动态
# import ./drama/app.js）。drama 的 rootDir 收窄到 src 使产物落在 dist/drama/。
RUN npx tsc -p tsconfig.json  && npx tsc -p tsconfig.drama.json --noEmit false --outDir dist --rootDir src
# admin SPA（/console）构建产物
COPY admin/package.json admin/package-lock.json ./admin/
RUN cd admin && npm ci --no-audit --no-fund && cd ..
COPY admin ./admin
RUN cd admin && npx vite build
# Prod-only node_modules, pruned in place after the compile: devDependencies
# the lockfile dev-marks (typescript, redis-memory-server, ...) leave; a few
# dev tools survive because they satisfy optional peers of PRODUCTION
# packages (better-auth → vitest/drizzle-kit, vite → esbuild/tsx) — npm's
# canonical prod tree. Those are pure JS or prebuilt binaries, so the runtime
# needs no toolchain (verified locally: npm ci 153 pkgs → prune 96 pkgs, all
# prod deps intact, none of the remainder compiles from source).
# Cross-arch note: the stage runs on the TARGET platform under buildx (no
# --platform=$BUILDPLATFORM override), so native modules match the runtime.
RUN npm prune --omit=dev

# Runtime: dependencies copied from the build stage — no compiler, no python,
# production packages only, non-root, no secrets in the image.
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# tsc 不搬运 JSON 资产：registry 快照随 dist 补齐（import.meta.url 相对定位）
COPY --from=build /app/src/modules/llm/models-registry.json ./dist/modules/llm/models-registry.json
COPY --from=build /app/admin/dist ./admin/dist
COPY drizzle ./drizzle
USER node
EXPOSE 30172
# Liveness is served at /healthz by the app itself.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:30172/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
