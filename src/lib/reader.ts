import { prisma } from "@/lib/db";

/**
 * Queries backing the reader view (SPEC.md §3.3).
 *
 * Position always comes from `orderIndex` — the reader resumes by index, never
 * by searching for remembered text (CLAUDE.md → Working Principles).
 */

/** Paragraphs rendered per screen; long novels are windowed, not fully loaded. */
export const READER_PAGE_SIZE = 30;

export interface ReaderParagraph {
  orderIndex: number;
  originalText: string;
  translatedText: string | null;
}

export interface ReaderPage {
  book: {
    id: string;
    title: string;
    author: string | null;
    totalParagraphs: number;
  };
  progress: {
    lastReadIndex: number;
    lastTranslatedIndex: number;
  };
  paragraphs: ReaderParagraph[];
  window: {
    from: number;
    prevFrom: number | null;
    nextFrom: number | null;
  };
  /** First paragraph in the whole book still awaiting translation, if any. */
  firstUntranslatedIndex: number | null;
  translatedCount: number;
}

/**
 * Loads one screen of a book, defaulting to `lastReadIndex + 1` so opening the
 * reader with no query string resumes exactly where the user stopped.
 */
export async function getReaderPage(
  bookId: string,
  requestedFrom?: number,
): Promise<ReaderPage | null> {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    include: { progress: true },
  });

  if (!book) return null;

  const lastReadIndex = book.progress?.lastReadIndex ?? -1;
  const lastTranslatedIndex = book.progress?.lastTranslatedIndex ?? -1;

  const from = clamp(
    requestedFrom ?? lastReadIndex + 1,
    0,
    Math.max(0, book.totalParagraphs - 1),
  );

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

  const nextFrom = from + READER_PAGE_SIZE;

  return {
    book: {
      id: book.id,
      title: book.title,
      author: book.author,
      totalParagraphs: book.totalParagraphs,
    },
    progress: { lastReadIndex, lastTranslatedIndex },
    paragraphs,
    window: {
      from,
      prevFrom: from > 0 ? Math.max(0, from - READER_PAGE_SIZE) : null,
      nextFrom: nextFrom < book.totalParagraphs ? nextFrom : null,
    },
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
export async function setLastReadIndex(bookId: string, lastReadIndex: number) {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { totalParagraphs: true },
  });

  if (!book) {
    throw new ProgressUpdateError(`Book ${bookId} not found.`, 404);
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
