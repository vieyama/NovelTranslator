# ================================
# Stage 1: deps
# ================================
FROM node:20-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# --ignore-scripts: postinstall runs `prisma generate`, which needs a
# resolvable DATABASE_URL (prisma.config.ts) that isn't copied into this
# stage. Generated explicitly in the builder stage instead, once the full
# source (and a build-time dummy DATABASE_URL) is present.
RUN npm ci --ignore-scripts


# ================================
# Stage 2: builder
# ================================
FROM node:20-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# DATABASE_URL just needs to be a syntactically valid `file:` path at build
# time — `prisma generate`'s config loader requires it resolvable, and later
# `next build` instantiates the Prisma client (db.ts) while tracing routes;
# better-sqlite3 will happily create an empty file here. The real path is
# injected at runtime via docker-compose, pointing at the mounted volume
# instead. Must be set BEFORE `prisma generate`, not just before `next build`.
ARG DATABASE_URL=file:./build.db
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
# deps/builder stages needs copying separately.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Where the persisted SQLite file lives — mounted as a volume in
# docker-compose.yml so it survives redeploys.
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

USER nextjs

EXPOSE 3007
ENV PORT=3007
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
