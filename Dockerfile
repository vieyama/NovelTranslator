# ================================
# Stage 1: deps
# ================================
FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY prisma ./prisma/

RUN bun install --frozen-lockfile


# ================================
# Stage 2: builder
# ================================
FROM oven/bun:1 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN bunx prisma generate

# DATABASE_URL is required at build time because Next.js attempts to
# statically analyse routes that import Prisma. Pass a dummy value here;
# the real value is injected at runtime via docker-compose environment.
# Recommended fix: add `export const dynamic = 'force-dynamic'` to any
# API route that uses Prisma so Next.js skips static generation for it.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=${DATABASE_URL}

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build


# ================================
# Stage 3: runner
# ================================
FROM oven/bun:1-slim AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="papre"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

# Copy Next.js standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 5002
ENV PORT=5002
ENV HOSTNAME="0.0.0.0"

CMD ["bun", "server.js"]