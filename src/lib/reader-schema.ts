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
  /**
   * "provider:model" that produced the current text, or null for paragraphs
   * translated before provenance was recorded. Shown in the reader so quality
   * can be judged against its source (SPEC.md §3.6).
   */
  translatedBy: string | null;
  /** True when a re-translation left a previous version that can be restored. */
  hasPreviousVersion: boolean;
}

/**
 * Splits a stored "provider:model" into something readable.
 *
 * Kept here rather than in the component so the reader and any future surface
 * format provenance the same way.
 */
export function describeTranslationSource(translatedBy: string | null): string | null {
  if (!translatedBy) return null;

  const separator = translatedBy.indexOf(":");
  if (separator === -1) return translatedBy;

  return translatedBy.slice(separator + 1) || translatedBy;
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
    lastTranslatedParagraphIndex: number;
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
