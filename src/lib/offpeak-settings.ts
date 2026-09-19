import "server-only";

import { prisma } from "@/lib/db";
import type {
  OffPeakSettingsView,
  SaveOffPeakSettingsInput,
} from "@/lib/offpeak-settings-schema";

const DEFAULTS = {
  maxChars: 3000,
  maxBatches: 50,
  delayMsBetweenBatches: 1000,
} as const;

export class OffPeakSettingsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "OffPeakSettingsError";
  }
}

export async function getOffPeakSettingsView(userId: string): Promise<OffPeakSettingsView> {
  const [config, books] = await Promise.all([
    prisma.offPeakTranslationConfig.findUnique({ where: { userId } }),
    prisma.book.findMany({
      where: { userId },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    }),
  ]);

  return {
    enabled: config?.enabled ?? false,
    bookId: config?.bookId ?? books[0]?.id ?? "",
    maxChars: config?.maxChars ?? DEFAULTS.maxChars,
    maxBatches: config?.maxBatches ?? DEFAULTS.maxBatches,
    delayMsBetweenBatches: config?.delayMsBetweenBatches ?? DEFAULTS.delayMsBetweenBatches,
    lastRunAt: config?.lastRunAt?.toISOString() ?? null,
    lastError: config?.lastError ?? null,
    books,
  };
}

export async function saveOffPeakSettings(
  userId: string,
  input: SaveOffPeakSettingsInput,
): Promise<OffPeakSettingsView> {
  const enabled = booleanValue(input.enabled, "enabled");
  const bookId = stringValue(input.bookId, "bookId");
  const maxChars = integerValue(input.maxChars, "maxChars", 100, 100_000);
  const maxBatches = integerValue(input.maxBatches, "maxBatches", 1, 10_000);
  const delayMsBetweenBatches = integerValue(
    input.delayMsBetweenBatches,
    "delayMsBetweenBatches",
    0,
    60_000,
  );

  const book = await prisma.book.findFirst({
    where: { id: bookId, userId },
    select: { id: true },
  });
  if (!book) throw new OffPeakSettingsError("Buku tidak ditemukan.", 404);

  await prisma.offPeakTranslationConfig.upsert({
    where: { userId },
    create: { userId, bookId, enabled, maxChars, maxBatches, delayMsBetweenBatches },
    update: { bookId, enabled, maxChars, maxBatches, delayMsBetweenBatches, lastError: null },
  });

  return getOffPeakSettingsView(userId);
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OffPeakSettingsError(`${name} wajib diisi.`);
  }
  return value.trim();
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new OffPeakSettingsError(`${name} harus boolean.`);
  return value;
}

function integerValue(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new OffPeakSettingsError(`${name} harus bilangan bulat antara ${min} dan ${max}.`);
  }
  return value;
}
