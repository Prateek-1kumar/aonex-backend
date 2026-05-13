# ── Stage 1: Build ──────────────────────────────────────────────────────
FROM oven/bun:1.2 AS builder

WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock turbo.json ./

# Copy all packages
COPY apps/ ./apps/
COPY packages/ ./packages/

# Install all dependencies
RUN bun install --frozen-lockfile

# Build the packages that need compilation
RUN bun run --filter "@aonex/types" build 2>/dev/null || true
RUN bun run --filter "@aonex/db" build 2>/dev/null || true
RUN bun run --filter "@aonex/connector-gateway" build 2>/dev/null || true

# ── Stage 2: API Runtime ─────────────────────────────────────────────────
FROM oven/bun:1.2-slim AS api

WORKDIR /app

COPY --from=builder /app ./

EXPOSE 8787

ENV NODE_ENV=production

CMD ["bun", "run", "--env-file=.env", "apps/api/src/index.ts"]
