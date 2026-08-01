/**
 * Library sort options, shared by client and server.
 *
 * Kept separate from `books.ts` for the same reason as `reader-schema.ts` /
 * `glossary-schema.ts`: that module imports Prisma, so anything a Client
 * Component needs (here: the option list the sort control renders) has to live
 * in a module that doesn't. See CLAUDE.md → "Server / Client Module Boundary".
 */

/** Order matters — this is the order the options appear in the control. */
export const BOOK_SORT_OPTIONS = [
  { value: "recent", label: "Terbaru ditambahkan" },
  { value: "oldest", label: "Terlama ditambahkan" },
  { value: "title", label: "Judul A–Z" },
  { value: "title-desc", label: "Judul Z–A" },
  { value: "reading", label: "Paling banyak dibaca" },
  { value: "translation", label: "Paling banyak diterjemahkan" },
] as const;

export type BookSort = (typeof BOOK_SORT_OPTIONS)[number]["value"];

/** Matches the pre-sorting behaviour, so `/books` with no query is unchanged. */
export const DEFAULT_BOOK_SORT: BookSort = "recent";

const VALID_SORTS = new Set<string>(BOOK_SORT_OPTIONS.map((option) => option.value));

/**
 * Narrows an untrusted `?sort=` value to a `BookSort`.
 *
 * Anything unrecognised falls back to the default rather than erroring — a
 * hand-edited or stale URL should still render the library, not a 500.
 */
export function parseBookSort(value: string | undefined | null): BookSort {
  return value !== undefined && value !== null && VALID_SORTS.has(value)
    ? (value as BookSort)
    : DEFAULT_BOOK_SORT;
}

/**
 * Builds the href for a sort option.
 *
 * The default sort is expressed as a bare `/books` rather than
 * `/books?sort=recent`, so the library has exactly one canonical URL.
 */
export function hrefForBookSort(sort: BookSort): string {
  return sort === DEFAULT_BOOK_SORT ? "/books" : `/books?sort=${sort}`;
}
