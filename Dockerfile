# ================================
# Stage 1: deps
# ================================
FROM node:20-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# Skip postinstall (prisma generate) until the full source and a build-time
# DATABASE_URL are available.
RUN npm ci --ignore-scripts


# ================================
# Stage 2: builder
# ================================
FROM node:20-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

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

# Standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# --------------------------------------------------------------------
# Prisma 7 + better-sqlite3
# --------------------------------------------------------------------

# Generated Prisma client (generator output = src/generated/prisma)
COPY --from=builder --chown=nextjs:nodejs /app/src/generated ./src/generated

# Prisma adapter (contains nested better-sqlite3)
COPY --from=builder --chown=nextjs:nodejs \
    /app/node_modules/@prisma \
    ./node_modules/@prisma

# Copy nested native binary explicitly
COPY --from=builder --chown=nextjs:nodejs \
    /app/node_modules/@prisma/adapter-better-sqlite3/node_modules \
    ./node_modules/@prisma/adapter-better-sqlite3/node_modules

# --------------------------------------------------------------------

RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

USER nextjs

EXPOSE 3007
ENV PORT=3007
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]