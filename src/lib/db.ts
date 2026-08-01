// Server-only: importing this from a Client Component would pull secrets
// into the browser bundle. Prisma client + pg driver.
import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Prisma 7 requires an explicit driver adapter; DATABASE_URL is a
// postgresql:// connection string, matching prisma.config.ts.
function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });

  return new PrismaClient({ adapter });
}

// Next.js hot-reloads modules in dev, which would otherwise open a new pg
// connection pool on every reload. Cache the instance on globalThis.
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
