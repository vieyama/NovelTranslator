# Runtime is Bun (SPEC.md §7.2). The `pg` driver adapter is pure JS, so none of
# the native-binding problems that forced Node.js while the driver was
# better-sqlite3 apply any more.

# ================================
# Stage 1: deps
# ================================
FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# package.json's `postinstall` runs `prisma generate`, and Prisma's config
# loader resolves the datasource URL before it runs — so DATABASE_URL has to be
# set here, not just before `next build`. Dummy value; the real one is injected
# at runtime by docker-compose.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=${DATABASE_URL}

RUN bun install --frozen-lockfile


# ================================
# Stage 2: builder
# ================================
FROM oven/bun:1 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# DATABASE_URL must be set BEFORE `prisma generate` (its config loader resolves
# the datasource URL first) and before `next build` (Next.js statically analyses
# routes that import Prisma). Dummy value — `pg.Pool` connects lazily, so a
# merely-syntactically-valid URL is enough at build time (SPEC.md §7.1); the
# real value is injected at runtime via docker-compose.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=${DATABASE_URL}

# Generate Prisma client
RUN bunx prisma generate

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build


# ================================
# Stage 3: runner
# ================================
FROM oven/bun:1-slim AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="Novel Translator"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

# Copy Next.js standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3007
ENV PORT=3007
ENV HOSTNAME="0.0.0.0"

CMD ["bun", "server.js"]