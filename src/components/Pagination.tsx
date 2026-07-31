"use client";

import Link from "next/link";

/**
 * Generic numeric pagination — First/Prev/[windowed page numbers]/Next/Last.
 *
 * Presentational only: the caller owns what a "page" means (here, a fixed-size
 * `orderIndex` window — see `reader-schema.ts`) and supplies `getHref` so this
 * component has no reader-specific knowledge. Navigation goes through
 * `next/link`, so paging never triggers a full page reload; disabled ends are
 * real `<button disabled>` elements rather than dead links, since an `<a>` has
 * no accessible disabled state.
 *
 * Two layouts are rendered and toggled with CSS breakpoints rather than a
 * client-side media query — that would need `useEffect`/`useState` to read
 * `window` and cause a hydration mismatch (server can't know viewport width).
 * Both layouts are cheap: their page-number count is bounded by
 * `siblingCount`, never by `totalPages` (windowed, not exhaustive — a
 * 3000-paragraph, 100-page book still renders at most ~9 page buttons).
 */

const ELLIPSIS = "ellipsis" as const;
type PageItem = number | typeof ELLIPSIS;

const DESKTOP_SIBLING_COUNT = 2;
const MOBILE_SIBLING_COUNT = 1;

export function Pagination({
  currentPage,
  totalPages,
  getHref,
  className = "",
}: {
  currentPage: number;
  totalPages: number;
  getHref: (page: number) => string;
  className?: string;
}) {
  if (totalPages <= 1) return null;

  const isFirst = currentPage <= 1;
  const isLast = currentPage >= totalPages;

  return (
    <nav aria-label="Navigasi halaman" className={className}>
      {/* Mobile: compact, no first/last/ellipsis — matches the touch-first layout. */}
      <ul className="flex items-center justify-center gap-1 sm:hidden">
        <EdgeControl direction="prev" href={!isFirst ? getHref(currentPage - 1) : null} />
        {getCompactPageRange(currentPage, totalPages, MOBILE_SIBLING_COUNT).map((page) => (
          <PageNumberItem
            key={page}
            page={page}
            isCurrent={page === currentPage}
            href={getHref(page)}
          />
        ))}
        <EdgeControl direction="next" href={!isLast ? getHref(currentPage + 1) : null} />
      </ul>

      {/* Desktop: full First/Prev/…/Next/Last with ellipses. */}
      <ul className="hidden items-center justify-center gap-1 sm:flex">
        <EdgeControl direction="first" href={!isFirst ? getHref(1) : null} />
        <EdgeControl direction="prev" href={!isFirst ? getHref(currentPage - 1) : null} />
        {getPageRangeWithEllipsis(currentPage, totalPages, DESKTOP_SIBLING_COUNT).map(
          (item, index) =>
            item === ELLIPSIS ? (
              <EllipsisItem key={`ellipsis-${index}`} />
            ) : (
              <PageNumberItem
                key={item}
                page={item}
                isCurrent={item === currentPage}
                href={getHref(item)}
              />
            ),
        )}
        <EdgeControl direction="next" href={!isLast ? getHref(currentPage + 1) : null} />
        <EdgeControl direction="last" href={!isLast ? getHref(totalPages) : null} />
      </ul>
    </nav>
  );
}

const BUTTON_BASE =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500";

function PageNumberItem({
  page,
  isCurrent,
  href,
}: {
  page: number;
  isCurrent: boolean;
  href: string;
}) {
  return (
    <li>
      {isCurrent ? (
        <span
          aria-current="page"
          className={`${BUTTON_BASE} bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900`}
        >
          {page}
        </span>
      ) : (
        <Link
          href={href}
          aria-label={`Ke halaman ${page}`}
          className={`${BUTTON_BASE} text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800`}
        >
          {page}
        </Link>
      )}
    </li>
  );
}

function EllipsisItem() {
  return (
    <li aria-hidden="true" className={`${BUTTON_BASE} text-zinc-400 dark:text-zinc-600`}>
      …
    </li>
  );
}

const EDGE_LABELS = {
  first: { label: "Halaman pertama", glyph: "«" },
  prev: { label: "Halaman sebelumnya", glyph: "‹" },
  next: { label: "Halaman berikutnya", glyph: "›" },
  last: { label: "Halaman terakhir", glyph: "»" },
} as const;

/** First / Prev / Next / Last control — a real disabled button at either end, a link otherwise. */
function EdgeControl({
  direction,
  href,
}: {
  direction: keyof typeof EDGE_LABELS;
  href: string | null;
}) {
  const { label, glyph } = EDGE_LABELS[direction];

  return (
    <li>
      {href ? (
        <Link href={href} aria-label={label} className={`${BUTTON_BASE} text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800`}>
          {glyph}
        </Link>
      ) : (
        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-label={label}
          className={`${BUTTON_BASE} cursor-not-allowed text-zinc-300 dark:text-zinc-700`}
        >
          {glyph}
        </button>
      )}
    </li>
  );
}

/** `[1, ELLIPSIS, 8, 9, 10, 11, 12, ELLIPSIS, 35]` — bounded length regardless of `totalPages`. */
export function getPageRangeWithEllipsis(
  currentPage: number,
  totalPages: number,
  siblingCount: number,
): PageItem[] {
  // first + last + current + siblings on both sides + up to 2 ellipses.
  const totalSlotsWithoutEllipsis = siblingCount * 2 + 3;

  if (totalPages <= totalSlotsWithoutEllipsis + 2) {
    return range(1, totalPages);
  }

  const leftSibling = Math.max(currentPage - siblingCount, 1);
  const rightSibling = Math.min(currentPage + siblingCount, totalPages);

  const showLeftEllipsis = leftSibling > 2;
  const showRightEllipsis = rightSibling < totalPages - 1;

  if (!showLeftEllipsis && showRightEllipsis) {
    const leftItemCount = totalSlotsWithoutEllipsis;
    return [...range(1, leftItemCount), ELLIPSIS, totalPages];
  }

  if (showLeftEllipsis && !showRightEllipsis) {
    const rightItemCount = totalSlotsWithoutEllipsis;
    return [1, ELLIPSIS, ...range(totalPages - rightItemCount + 1, totalPages)];
  }

  return [1, ELLIPSIS, ...range(leftSibling, rightSibling), ELLIPSIS, totalPages];
}

/** Mobile variant: just a clamped window around the current page, never an ellipsis. */
export function getCompactPageRange(
  currentPage: number,
  totalPages: number,
  siblingCount: number,
): number[] {
  const start = Math.max(1, currentPage - siblingCount);
  const end = Math.min(totalPages, currentPage + siblingCount);
  return range(start, end);
}

function range(start: number, end: number): number[] {
  if (end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
