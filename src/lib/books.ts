// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Prisma.
import "server-only";

import { prisma } from "@/lib/db";
import { EpubParseError, parse as parseEpub } from "@/lib/parser/epub";
import { parse as parseTxt } from "@/lib/parser/txt";
import type { ParsedParagraph } from "@/lib/parser/types";

/** MVP supports .txt only; epub/pdf land in Phase 6 (TASKS.md). */
const SUPPORTED_FORMATS = ["txt", "epub"] as const;
type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/** Guard against accidentally uploading something enormous into SQLite. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** SQLite has a bound-parameter limit, so paragraphs are inserted in chunks. */
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
  file: File;
  title?: string | null;
  author?: string | null;
}

/**
 * Parses an uploaded novel and persists Book + Paragraph[] + initial
 * ReadingProgress (both indexes at -1), per SPEC.md §3.1.
 */
export async function createBookFromUpload({ file, title, author }: CreateBookInput) {
  const format = detectFormat(file.name);

  if (file.size === 0) {
    throw new BookImportError("File is empty.", 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new BookImportError(
      `File is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}.`,
      413,
    );
  }

  const paragraphs = parseByFormat(format, new Uint8Array(await file.arrayBuffer()));

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
}

/** Library listing with the progress summary the /books page needs (SPEC.md §3.4). */
export async function listBooksWithProgress(): Promise<BookSummary[]> {
  const books = await prisma.book.findMany({
    orderBy: { createdAt: "desc" },
    include: { progress: true },
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

  return books.map((book) => {
    const lastTranslatedIndex = book.progress?.lastTranslatedIndex ?? -1;
    const lastReadIndex = book.progress?.lastReadIndex ?? -1;

    return {
      id: book.id,
      title: book.title,
      author: book.author,
      sourceFormat: book.sourceFormat,
      totalParagraphs: book.totalParagraphs,
      createdAt: book.createdAt,
      lastTranslatedIndex,
      lastReadIndex,
      translatedCount: countByBookId.get(book.id) ?? 0,
      // Indexes are 0-based, so "+ 1" converts a position into a count.
      translatedPercent: toPercent(lastTranslatedIndex + 1, book.totalParagraphs),
      readPercent: toPercent(lastReadIndex + 1, book.totalParagraphs),
    };
  });
}

function parseByFormat(format: SupportedFormat, bytes: Uint8Array): ParsedParagraph[] {
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

function toPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  const clamped = Math.min(Math.max(done, 0), total);
  return Math.round((clamped / total) * 100);
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
