/**
 * Reader shapes shared by client and server.
 *
 * Kept separate from `reader.ts` for the same reason as `glossary-schema.ts`:
 * that module imports Prisma, so anything a Client Component needs has to live
 * in a module that doesn't.
 */

/** Paragraphs rendered per screen; long novels are windowed, not fully loaded. */
export const READER_PAGE_SIZE = 30;

export interface ReaderParagraph {
  orderIndex: number;
  originalText: string;
  /** `null` = not yet translated. */
  translatedText: string | null;
}

export interface ReaderPagination {
  /** 1-based. */
  currentPage: number;
  totalPages: number;
  pageSize: number;
  /** Absolute orderIndex the current page starts at — `(currentPage - 1) * pageSize`. */
  from: number;
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
  pagination: ReaderPagination;
  /** First paragraph in the whole book still awaiting translation, if any. */
  firstUntranslatedIndex: number | null;
  translatedCount: number;
}

/**
 * Converts an absolute paragraph index into its 1-based page number.
 *
 * Pages are fixed-size, `orderIndex`-aligned windows — the same source of
 * truth used for reading and translation progress — so a page number always
 * means the same window regardless of who's asking (CLAUDE.md → `orderIndex`
 * is the single source of truth).
 */
export function pageForIndex(index: number, pageSize: number = READER_PAGE_SIZE): number {
  return Math.floor(Math.max(index, 0) / pageSize) + 1;
}

/** Inverse of `pageForIndex`: the first `orderIndex` a page contains. */
export function fromForPage(page: number, pageSize: number = READER_PAGE_SIZE): number {
  return Math.max(page - 1, 0) * pageSize;
}

/** At least 1, even for a book with zero paragraphs, so "page 1 of 1" is always valid to render. */
export function totalPagesFor(totalParagraphs: number, pageSize: number = READER_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(totalParagraphs / pageSize));
}
