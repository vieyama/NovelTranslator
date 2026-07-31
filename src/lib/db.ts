// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Prisma client + native better-sqlite3 binding.
import "server-only";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

// Prisma 7 requires an explicit driver adapter; the URL is root-relative
// (dev.db sits next to package.json), matching prisma.config.ts.
function createPrismaClient() {
  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./dev.db",
  });

  return new PrismaClient({ adapter });
}

// Next.js hot-reloads modules in dev, which would otherwise open a new SQLite
// connection on every reload. Cache the instance on globalThis.
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
