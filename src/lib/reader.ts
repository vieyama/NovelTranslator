// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Prisma.
import "server-only";

import { prisma } from "@/lib/db";
import { BookAccessError } from "@/lib/ownership";
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

  const totalPages = totalPagesFor(book.totalParagraphs, READER_PAGE_SIZE);
  const defaultPage = pageForIndex(lastReadIndex + 1, READER_PAGE_SIZE);
  const currentPage = clamp(requestedPage ?? defaultPage, 1, totalPages);
  const from = fromForPage(currentPage, READER_PAGE_SIZE);

  const [paragraphs, firstUntranslated, translatedCount] = await Promise.all([
    prisma.paragraph.findMany({
      where: { bookId, orderIndex: { gte: from } },
      orderBy: { orderIndex: "asc" },
      take: READER_PAGE_SIZE,
      select: { orderIndex: true, originalText: true, translatedText: true },
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
    progress: { lastReadIndex, lastTranslatedIndex },
    paragraphs,
    pagination: { currentPage, totalPages, pageSize: READER_PAGE_SIZE, from },
    firstUntranslatedIndex: firstUntranslated?.orderIndex ?? null,
    translatedCount,
  };
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
    select: { lastReadIndex: true, lastTranslatedIndex: true, updatedAt: true },
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
