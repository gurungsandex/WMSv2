# Build context is the repository root (see docker-compose.yml), so this
# image can compile the agent binaries it serves from /download/*.

# ── Agent binaries ────────────────────────────────────────────────────────────
# Cross-compiled here so `docker compose up` is self-contained: without this
# stage /download/* 404s and no workstation can be enrolled.
FROM golang:1.22-alpine AS agent
WORKDIR /agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
ENV CGO_ENABLED=0
RUN set -eux; \
    for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do \
      os="${target%/*}"; arch="${target#*/}"; ext=""; \
      [ "$os" = "windows" ] && ext=".exe"; \
      GOOS="$os" GOARCH="$arch" go build -ldflags="-s -w" \
        -o "/out/wms-agent-${os}-${arch}${ext}" .; \
    done; \
    ls -lh /out

# ── Server dependencies ───────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

# ── Server build ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json* server/tsconfig.json ./
RUN npm ci
COPY server/src ./src
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=agent /out ./binaries
COPY server/scripts ./scripts
EXPOSE 4000
CMD ["sh", "-c", "node scripts/migrate.js && node dist/main.js"]
