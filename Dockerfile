# ================================
# Stage 1: deps
# ================================
FROM node:20-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# The root postinstall (`prisma generate`) needs a resolvable DATABASE_URL,
# not available at this stage — scripts are skipped here and the client is
# generated explicitly in the builder stage instead, once the full source
# (and a build-time dummy DATABASE_URL) is present. Safe to skip here: unlike
# better-sqlite3 (this project's previous driver, before switching to
# Postgres), `pg` is pure JS — no native binary to fetch/build via an
# install script, so --ignore-scripts has nothing to silently break.
RUN npm ci --ignore-scripts


# ================================
# Stage 2: builder
# ================================
FROM node:20-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Just needs to be a syntactically valid postgresql:// URL — pg.Pool (unlike
# better-sqlite3) never connects eagerly at construction, only lazily on the
# first query, so this never actually needs to be reachable during the build.
# The real value is injected at runtime via docker-compose, pointing at the
# `postgres` service instead.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=${DATABASE_URL}
ENV NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate
RUN npm run build


# ================================
# Stage 3: runner
# ================================
FROM node:20-slim AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="novel-translator"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

# Next.js standalone output (next.config.ts `output: "standalone"`) is
# self-contained — it ships its own pruned node_modules, so nothing from the
# deps/builder stages needs copying separately. (No more manual
# native-binary copying here — that was a better-sqlite3-specific problem,
# gone now that the driver is pg, pure JS.)
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Generated Prisma client (generator output = src/generated/prisma) lives
# outside node_modules, alongside the app's own source — copied explicitly
# since standalone's output-file tracing only covers node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/src/generated ./src/generated

USER nextjs

EXPOSE 3007
ENV PORT=3007
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
