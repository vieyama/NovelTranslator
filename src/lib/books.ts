// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Prisma.
import "server-only";

import { DEFAULT_BOOK_SORT, type BookSort } from "@/lib/books-schema";
import { prisma } from "@/lib/db";
import { BookAccessError } from "@/lib/ownership";
import { EpubParseError, parse as parseEpub } from "@/lib/parser/epub";
import { PdfParseError, parse as parsePdf } from "@/lib/parser/pdf";
import { parse as parseTxt } from "@/lib/parser/txt";
import type { ParsedParagraph } from "@/lib/parser/types";

/** Formats with a working parser. */
const SUPPORTED_FORMATS = ["txt", "epub", "pdf"] as const;
type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/** Guard against accidentally uploading something enormous into memory/DB. */
const MAX_FILE_BYTES_BY_FORMAT: Record<SupportedFormat, number> = {
  txt: 20 * 1024 * 1024,
  epub: 100 * 1024 * 1024,
  pdf: 100 * 1024 * 1024,
};

/** Keep bulk inserts comfortably below database/driver parameter limits. */
const INSERT_CHUNK_SIZE = 500;

export class BookImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BookImportError";
  }
}

export interface CreateBookInput {
  /** Owner of the new book — books are per-user (SPEC.md §8). */
  userId: string;
  file: File;
  title?: string | null;
  author?: string | null;
}

/**
 * Parses an uploaded novel and persists Book + Paragraph[] + initial
 * ReadingProgress (both indexes at -1), per SPEC.md §3.1.
 */
export async function createBookFromUpload({ userId, file, title, author }: CreateBookInput) {
  const format = detectFormat(file.name);

  if (file.size === 0) {
    throw new BookImportError("File is empty.", 400);
  }
  const maxFileBytes = MAX_FILE_BYTES_BY_FORMAT[format];

  if (file.size > maxFileBytes) {
    throw new BookImportError(
      `File is ${formatBytes(file.size)}; the limit for .${format} is ${formatBytes(maxFileBytes)}.`,
      413,
    );
  }

  const paragraphs = await parseByFormat(format, new Uint8Array(await file.arrayBuffer()));

  if (paragraphs.length === 0) {
    throw new BookImportError(
      "No paragraphs found. Expected plain text with paragraphs separated by a blank line.",
      422,
    );
  }

  const resolvedTitle = title?.trim() || stripExtension(file.name) || "Untitled";

  // One transaction: a book must never exist without its paragraphs/progress.
  return prisma.$transaction(async (tx) => {
    const book = await tx.book.create({
      data: {
        userId,
        title: resolvedTitle,
        author: author?.trim() || null,
        sourceFormat: format,
        totalParagraphs: paragraphs.length,
        progress: {
          // -1 = nothing translated, nothing read yet (SPEC.md §2).
          create: { lastTranslatedIndex: -1, lastReadIndex: -1 },
        },
      },
    });

    for (let i = 0; i < paragraphs.length; i += INSERT_CHUNK_SIZE) {
      await tx.paragraph.createMany({
        data: paragraphs.slice(i, i + INSERT_CHUNK_SIZE).map((paragraph) => ({
          bookId: book.id,
          // orderIndex comes straight from the parser — never recomputed here.
          orderIndex: paragraph.orderIndex,
          chapterIndex: paragraph.chapterIndex ?? null,
          originalText: paragraph.originalText,
          charCount: paragraph.charCount,
        })),
      });
    }

    return book;
  });
}

/**
 * Deletes a book and everything hanging off it (SPEC.md §4).
 *
 * Paragraphs, progress, and glossary terms go with it via `onDelete: Cascade`
 * (schema.prisma) — verified in Phase 2 to leave no orphan rows. Translated
 * text is destroyed too; this is irreversible, so the UI must confirm first.
 */
export async function deleteBook(bookId: string, userId: string): Promise<{ title: string }> {
  // Scoped by owner, so deleting someone else's book is a 404 rather than a
  // successful cascade (SPEC.md §8 — this is the one irreversible action).
  const book = await prisma.book.findFirst({
    where: { id: bookId, userId },
    select: { id: true, title: true },
  });

  if (!book) {
    throw new BookImportError(new BookAccessError(bookId).message, 404);
  }

  await prisma.book.delete({ where: { id: book.id } });

  return { title: book.title };
}

export interface BookSummary {
  id: string;
  title: string;
  author: string | null;
  sourceFormat: string;
  totalParagraphs: number;
  createdAt: Date;
  lastTranslatedIndex: number;
  lastReadIndex: number;
  translatedCount: number;
  translatedPercent: number;
  readPercent: number;
  tokenUsage: BookTokenUsageSummary[];
}

export interface BookTokenUsageSummary {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  updatedAt: Date;
}

/** Library listing with the progress summary the /books page needs (SPEC.md §3.4). */
export async function listBooksWithProgress(
  userId: string,
  sort: BookSort = DEFAULT_BOOK_SORT,
): Promise<BookSummary[]> {
  const books = await prisma.book.findMany({
    where: { userId },
    // Newest-first is the base order, then `sort` is applied to the derived
    // summaries below. Sorting can't be pushed entirely into the query: the
    // progress options rank by percentages that don't exist as columns —
    // they're computed from `lastTranslatedIndex` and the grouped translated
    // count. Doing all six in one place beats splitting them across a Prisma
    // `orderBy` and a JS comparator, and the library is a single user's
    // bookshelf (tens of rows), not something that scales with book length.
    orderBy: { createdAt: "desc" },
    include: {
      progress: true,
      tokenUsage: {
        orderBy: [{ provider: "asc" }, { model: "asc" }],
        select: {
          provider: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          updatedAt: true,
        },
      },
    },
  });

  if (books.length === 0) return [];

  // One grouped query instead of a count per book.
  const translatedCounts = await prisma.paragraph.groupBy({
    by: ["bookId"],
    where: {
      bookId: { in: books.map((book) => book.id) },
      translatedText: { not: null },
    },
    _count: { _all: true },
  });

  const countByBookId = new Map(
    translatedCounts.map((row) => [row.bookId, row._count._all]),
  );

  const summaries = books.map((book) => {
    const lastTranslatedIndex = book.progress?.lastTranslatedIndex ?? -1;
    const lastReadIndex = book.progress?.lastReadIndex ?? -1;
    const translatedCount = countByBookId.get(book.id) ?? 0;

    return {
      id: book.id,
      title: book.title,
      author: book.author,
      sourceFormat: book.sourceFormat,
      totalParagraphs: book.totalParagraphs,
      createdAt: book.createdAt,
      lastTranslatedIndex,
      lastReadIndex,
      translatedCount,
      // Counted, not derived from `lastTranslatedIndex`.
      //
      // That watermark stops at the first untranslated gap, so translating past
      // one (which `fromIndex` explicitly allows — SPEC.md §3.2) pins it in
      // place: a book with 20 paragraphs translated but a gap at the very start
      // would report 0%, right beside a "20/2879" taken from the real count.
      // The number and the percentage have to describe the same thing.
      translatedPercent: toPercent(translatedCount, book.totalParagraphs),
      // Reading, by contrast, genuinely is a watermark — "read up to here" —
      // so there is no gap for a count to disagree about. "+ 1" turns a 0-based
      // position into a count.
      readPercent: toPercent(lastReadIndex + 1, book.totalParagraphs),
      tokenUsage: book.tokenUsage,
    };
  });

  // `sort` is stable in JS, so every comparator that returns 0 for a tie falls
  // back to the newest-first order the query already produced — e.g. sorting a
  // fresh library by progress leaves it in "recently added" order rather than
  // an arbitrary one, because every book is at 0%.
  return summaries.sort(BOOK_COMPARATORS[sort]);
}

/**
 * Progress comparators rank by *ratio*, not by the rounded percentage shown in
 * the UI — otherwise 2/3 and 67/100 would tie at 67% and be ordered by
 * insertion instead of by how far along they actually are.
 *
 * Each uses the same basis as the percentage it sorts by: translation counts
 * actual translated paragraphs, reading uses the `lastReadIndex` watermark.
 * Sorting on a different basis than the number on screen would put a book
 * showing 80% above one showing 90%.
 */
const BOOK_COMPARATORS: Record<BookSort, (a: BookSummary, b: BookSummary) => number> = {
  recent: (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  oldest: (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  title: (a, b) => compareTitles(a, b),
  "title-desc": (a, b) => compareTitles(b, a),
  reading: (a, b) =>
    progressRatio(b.lastReadIndex + 1, b.totalParagraphs) -
    progressRatio(a.lastReadIndex + 1, a.totalParagraphs),
  translation: (a, b) =>
    progressRatio(b.translatedCount, b.totalParagraphs) -
    progressRatio(a.translatedCount, a.totalParagraphs),
};

/**
 * Locale-aware so Indonesian titles sort the way a reader expects, and
 * case/accent-insensitive so "anna" and "Anna" don't end up in separate runs.
 */
function compareTitles(a: BookSummary, b: BookSummary): number {
  return a.title.localeCompare(b.title, "id", { sensitivity: "base", numeric: true });
}

async function parseByFormat(format: SupportedFormat, bytes: Uint8Array): Promise<ParsedParagraph[]> {
  switch (format) {
    case "txt":
      return parseTxt(bytes);
    case "epub":
      try {
        return parseEpub(bytes);
      } catch (error) {
        // A malformed EPUB is the user's file being wrong, not a server fault.
        if (error instanceof EpubParseError) {
          throw new BookImportError(error.message, 422);
        }
        throw error;
      }
    case "pdf":
      try {
        return await parsePdf(bytes);
      } catch (error) {
        if (error instanceof PdfParseError) {
          throw new BookImportError(error.message, 422);
        }
        throw error;
      }
  }
}

function detectFormat(fileName: string): SupportedFormat {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";

  if (!SUPPORTED_FORMATS.includes(extension as SupportedFormat)) {
    throw new BookImportError(
      `Unsupported file type ".${extension}". Supported: ${SUPPORTED_FORMATS.map((f) => `.${f}`).join(", ")}.`,
      415,
    );
  }

  return extension as SupportedFormat;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "").trim();
}

/** 0–1, clamped. Shared by the displayed percentage and the sort comparators. */
function progressRatio(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(done, 0), total) / total;
}

function toPercent(done: number, total: number): number {
  return Math.round(progressRatio(done, total) * 100);
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
