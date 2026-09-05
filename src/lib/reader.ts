// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Prisma.
import "server-only";

import { prisma } from "@/lib/db";
import { BookAccessError, assertBookOwned } from "@/lib/ownership";
import {
  READER_PAGE_SIZE,
  fromForPage,
  pageForIndex,
  totalPagesFor,
  type ReaderPage,
  type ReaderParagraph,
} from "@/lib/reader-schema";

/**
 * Queries backing the reader view (SPEC.md §3.3).
 *
 * Position always comes from `orderIndex` — the reader resumes by index, never
 * by searching for remembered text (CLAUDE.md → Working Principles). Pages are
 * fixed-size, `orderIndex`-aligned windows (see `reader-schema.ts`), so numeric
 * pagination and auto-resume are both just different ways of picking a page.
 */

export { READER_PAGE_SIZE };
export type { ReaderPage, ReaderParagraph };

/**
 * Loads one screen of a book. With no `requestedPage`, resumes on the page
 * containing `lastReadIndex + 1` — opening the reader with a bare URL still
 * lands where the user stopped, now expressed as a page instead of a raw
 * index.
 */
export async function getReaderPage(
  bookId: string,
  userId: string,
  requestedPage?: number,
): Promise<ReaderPage | null> {
  // Ownership is part of the lookup, not a check after it: a book belonging to
  // someone else reads as "no such book" (SPEC.md §8), which is what the caller
  // renders as a 404.
  const book = await prisma.book.findFirst({
    where: { id: bookId, userId },
    include: { progress: true },
  });

  if (!book) return null;

  const lastReadIndex = book.progress?.lastReadIndex ?? -1;
  const lastTranslatedIndex = book.progress?.lastTranslatedIndex ?? -1;
  const lastTranslatedParagraphIndex = book.progress?.lastTranslatedParagraphIndex ?? -1;

  const totalPages = totalPagesFor(book.totalParagraphs, READER_PAGE_SIZE);
  const defaultPage = pageForIndex(lastReadIndex + 1, READER_PAGE_SIZE);
  const currentPage = clamp(requestedPage ?? defaultPage, 1, totalPages);
  const from = fromForPage(currentPage, READER_PAGE_SIZE);

  const [paragraphs, firstUntranslated, translatedCount] = await Promise.all([
    prisma.paragraph.findMany({
      where: { bookId, orderIndex: { gte: from } },
      orderBy: { orderIndex: "asc" },
      take: READER_PAGE_SIZE,
      select: {
        orderIndex: true,
        originalText: true,
        translatedText: true,
        translatedBy: true,
        previousTranslatedText: true,
      },
    }),
    prisma.paragraph.findFirst({
      where: { bookId, translatedText: null },
      orderBy: { orderIndex: "asc" },
      select: { orderIndex: true },
    }),
    prisma.paragraph.count({ where: { bookId, translatedText: { not: null } } }),
  ]);

  return {
    book: {
      id: book.id,
      title: book.title,
      author: book.author,
      totalParagraphs: book.totalParagraphs,
    },
    progress: { lastReadIndex, lastTranslatedIndex, lastTranslatedParagraphIndex },
    // `previousTranslatedText` is reduced to a boolean on purpose: the reader
    // only needs to know whether undo is available, and shipping a second full
    // copy of every paragraph to the browser would roughly double the payload.
    paragraphs: paragraphs.map(({ previousTranslatedText, ...paragraph }) => ({
      ...paragraph,
      hasPreviousVersion: previousTranslatedText !== null,
    })),
    pagination: { currentPage, totalPages, pageSize: READER_PAGE_SIZE, from },
    firstUntranslatedIndex: firstUntranslated?.orderIndex ?? null,
    translatedCount,
  };
}

/**
 * Restores the previous translation of one paragraph (SPEC.md §3.6).
 *
 * The undo half of re-translation: the two texts swap places rather than the
 * old one being copied over the new, so undo is itself undoable — click twice
 * and you are back where you started. That matters because the whole feature
 * exists for comparing two models, and a one-way undo just moves the trap.
 */
export async function revertTranslation(
  bookId: string,
  userId: string,
  orderIndex: number,
): Promise<{ translatedText: string; translatedBy: string | null }> {
  await assertBookOwned(bookId, userId);

  const paragraph = await prisma.paragraph.findFirst({
    where: { bookId, orderIndex },
    select: {
      id: true,
      translatedText: true,
      translatedBy: true,
      previousTranslatedText: true,
      previousTranslatedBy: true,
    },
  });

  if (!paragraph) {
    throw new ProgressUpdateError(`Paragraph #${orderIndex} not found.`, 404);
  }

  if (paragraph.previousTranslatedText === null) {
    throw new ProgressUpdateError("Paragraf ini tidak punya versi sebelumnya.", 400);
  }

  const restored = await prisma.paragraph.update({
    where: { id: paragraph.id },
    data: {
      translatedText: paragraph.previousTranslatedText,
      translatedBy: paragraph.previousTranslatedBy,
      previousTranslatedText: paragraph.translatedText,
      previousTranslatedBy: paragraph.translatedBy,
    },
    select: { translatedText: true, translatedBy: true },
  });

  // Both sides are non-null here: the guard above proved the previous text
  // existed, and it is what was just written into `translatedText`.
  return {
    translatedText: restored.translatedText ?? "",
    translatedBy: restored.translatedBy,
  };
}

export async function updateParagraphText(
  bookId: string,
  userId: string,
  orderIndex: number,
  input: { originalText?: unknown; translatedText?: unknown },
): Promise<{
  paragraph: {
    orderIndex: number;
    originalText: string;
    translatedText: string | null;
    translatedBy: string | null;
  };
  progress: {
    lastTranslatedIndex: number;
    lastTranslatedParagraphIndex: number;
  };
}> {
  await assertBookOwned(bookId, userId);

  if (!Number.isInteger(orderIndex) || orderIndex < 0) {
    throw new ProgressUpdateError("`orderIndex` must be a non-negative integer.", 400);
  }

  const data: {
    originalText?: string;
    charCount?: number;
    translatedText?: string | null;
    translatedAt?: Date | null;
    translatedBy?: string | null;
    previousTranslatedText?: string | null;
    previousTranslatedBy?: string | null;
  } = {};

  if ("originalText" in input) {
    if (typeof input.originalText !== "string" || input.originalText.trim().length === 0) {
      throw new ProgressUpdateError("Teks asli tidak boleh kosong.", 400);
    }

    const originalText = input.originalText.trim();
    data.originalText = originalText;
    data.charCount = originalText.length;
  }

  const editsTranslation = "translatedText" in input;

  if (editsTranslation) {
    if (typeof input.translatedText !== "string") {
      throw new ProgressUpdateError("Teks terjemahan harus berupa string.", 400);
    }

    const translatedText = input.translatedText.trim();
    data.translatedText = translatedText.length > 0 ? translatedText : null;
    data.translatedAt = translatedText.length > 0 ? new Date() : null;
    data.translatedBy = translatedText.length > 0 ? "manual" : null;
  }

  if (Object.keys(data).length === 0) {
    throw new ProgressUpdateError("Tidak ada perubahan untuk disimpan.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.paragraph.findFirst({
      where: { bookId, orderIndex },
      select: {
        id: true,
        translatedText: true,
        translatedBy: true,
      },
    });

    if (!existing) {
      throw new ProgressUpdateError(`Paragraph #${orderIndex} not found.`, 404);
    }

    if (editsTranslation && existing.translatedText !== data.translatedText) {
      data.previousTranslatedText = existing.translatedText;
      data.previousTranslatedBy = existing.translatedBy;
    }

    const paragraph = await tx.paragraph.update({
      where: { id: existing.id },
      data,
      select: {
        orderIndex: true,
        originalText: true,
        translatedText: true,
        translatedBy: true,
      },
    });

    const progress = editsTranslation
      ? await settleTranslationProgress(tx, bookId)
      : await currentTranslationProgress(tx, bookId);

    return { paragraph, progress };
  });
}

export class ProgressUpdateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProgressUpdateError";
  }
}

/**
 * Moves the reading position (SPEC.md §4 — `PATCH /api/books/:id/progress`).
 *
 * Unlike `lastTranslatedIndex`, this may move backwards: re-reading an earlier
 * chapter is a normal thing to do.
 */
export async function setLastReadIndex(bookId: string, userId: string, lastReadIndex: number) {
  const book = await prisma.book.findFirst({
    where: { id: bookId, userId },
    select: { totalParagraphs: true },
  });

  if (!book) {
    throw new ProgressUpdateError(new BookAccessError(bookId).message, 404);
  }

  if (!Number.isInteger(lastReadIndex)) {
    throw new ProgressUpdateError("`lastReadIndex` must be an integer.", 400);
  }

  // -1 means "nothing read yet"; the upper bound is the last paragraph.
  if (lastReadIndex < -1 || lastReadIndex > book.totalParagraphs - 1) {
    throw new ProgressUpdateError(
      `\`lastReadIndex\` must be between -1 and ${book.totalParagraphs - 1}.`,
      400,
    );
  }

  return prisma.readingProgress.update({
    where: { bookId },
    data: { lastReadIndex },
    select: {
      lastReadIndex: true,
      lastTranslatedIndex: true,
      lastTranslatedParagraphIndex: true,
      updatedAt: true,
    },
  });
}

async function settleTranslationProgress(
  db: Pick<typeof prisma, "paragraph" | "readingProgress">,
  bookId: string,
): Promise<{ lastTranslatedIndex: number; lastTranslatedParagraphIndex: number }> {
  const [nextGap, maxTranslated] = await Promise.all([
    db.paragraph.findFirst({
      where: { bookId, translatedText: null },
      orderBy: { orderIndex: "asc" },
      select: { orderIndex: true },
    }),
    db.paragraph.aggregate({
      where: { bookId, translatedText: { not: null } },
      _max: { orderIndex: true },
    }),
  ]);

  const lastTranslatedIndex = nextGap ? nextGap.orderIndex - 1 : maxTranslated._max.orderIndex ?? -1;
  const lastTranslatedParagraphIndex = maxTranslated._max.orderIndex ?? -1;

  await db.readingProgress.update({
    where: { bookId },
    data: { lastTranslatedIndex, lastTranslatedParagraphIndex },
  });

  return { lastTranslatedIndex, lastTranslatedParagraphIndex };
}

async function currentTranslationProgress(
  db: Pick<typeof prisma, "readingProgress">,
  bookId: string,
): Promise<{ lastTranslatedIndex: number; lastTranslatedParagraphIndex: number }> {
  const progress = await db.readingProgress.findUnique({
    where: { bookId },
    select: { lastTranslatedIndex: true, lastTranslatedParagraphIndex: true },
  });

  return {
    lastTranslatedIndex: progress?.lastTranslatedIndex ?? -1,
    lastTranslatedParagraphIndex: progress?.lastTranslatedParagraphIndex ?? -1,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
