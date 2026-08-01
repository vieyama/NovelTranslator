"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * "Go to page" jump control — one action to reach any page, for books where
 * clicking through `Pagination`'s windowed numbers would take many steps.
 *
 * Generic and presentation-only, like `Pagination.tsx` beside it: it knows
 * about page numbers, not about books or paragraphs, and the caller supplies
 * `getHref` so the destination stays its business.
 *
 * Navigation goes through `router.push(getHref(page))` — the App Router client
 * navigation `next/link` already performs, so it shares the same router cache
 * and never triggers a document reload. Every jump is a real URL change, which
 * is what keeps the reader's `?page=` bookmarkable and Back-able (CLAUDE.md →
 * "Navigable state lives in the URL"), and leaves reading progress untouched:
 * that lives in the DB, keyed by `orderIndex`, not in this control.
 *
 * Two renderings, toggled with CSS breakpoints rather than a JS media query
 * (the same reason `Pagination` renders both its layouts — the server can't
 * know the viewport before hydration). Only one is in the accessibility tree at
 * a time, since Tailwind's `hidden` is `display: none`:
 *
 * - mobile: a native `<select>`, which opens the OS picker — the best possible
 *   touch target, at full width and standard control height.
 * - desktop: a number input backed by a `<datalist>`, so typing `150` narrows
 *   to "Halaman 150" and Enter jumps there without reaching for the mouse.
 *   A plain `<select>`'s type-ahead can't do this: it matches the option's text
 *   from the start, so typing "150" would search for a page labelled "150…"
 *   and never match "Halaman 150".
 */
export function GoToPage({
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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const fieldId = useId();
  const listId = `${fieldId}-pages`;

  // The typed value is a draft until submitted, so `currentPage` can't be used
  // directly — but it must re-sync whenever navigation lands on a new page.
  // Done by comparing against the last-seen prop during render (React's
  // "adjusting state when props change") rather than an effect or a `key`:
  // a `key` would remount the input and drop focus mid-typing.
  const [draft, setDraft] = useState(String(currentPage));
  const [syncedPage, setSyncedPage] = useState(currentPage);

  if (syncedPage !== currentPage) {
    setSyncedPage(currentPage);
    setDraft(String(currentPage));
  }

  const selectRef = useRef<HTMLSelectElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const refocusRef = useRef<"select" | "input" | null>(null);

  /**
   * Puts focus back on the control that triggered the jump.
   *
   * App Router navigation resets focus to `<body>` (it moves focus to the top
   * of the document so screen readers announce the new view), which would strand
   * a keyboard user after every jump — they'd have to tab all the way back to
   * change pages again. The elements themselves are *not* remounted across the
   * navigation, so re-focusing is restoring what was lost rather than fighting a
   * fresh render.
   *
   * Guarded on `document.body` still holding focus: if the reader has moved
   * focus somewhere deliberately while the page loaded, it stays where they put
   * it. Yanking focus back would be worse than losing it.
   */
  useEffect(() => {
    if (isPending || refocusRef.current === null) return;

    const target = refocusRef.current === "select" ? selectRef.current : inputRef.current;
    refocusRef.current = null;

    if (target && document.activeElement === document.body) {
      target.focus();
    }
  }, [isPending]);

  function goTo(page: number, source: "select" | "input") {
    if (page === currentPage) return;
    // Only armed once a navigation is really happening, so a no-op jump can't
    // leave it set and steal focus during some later, unrelated transition.
    refocusRef.current = source;
    startTransition(() => router.push(getHref(page)));
  }

  function submitDraft(event: React.FormEvent) {
    event.preventDefault();

    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(currentPage));
      return;
    }

    // Clamp rather than reject: someone typing past the end of a book means
    // "the last page", and silently doing nothing would look broken.
    const target = Math.min(Math.max(parsed, 1), totalPages);
    setDraft(String(target));
    goTo(target, "input");
  }

  if (totalPages <= 1) return null;

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <div className={className}>
      {/* Mobile: native picker, full width. */}
      <div className="sm:hidden">
        <label
          htmlFor={`${fieldId}-select`}
          className="block text-xs text-zinc-600 dark:text-zinc-400"
        >
          Ke halaman
        </label>
        <select
          id={`${fieldId}-select`}
          ref={selectRef}
          value={currentPage}
          disabled={isPending}
          onChange={(event) => goTo(Number(event.target.value), "select")}
          className="mt-1 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 disabled:cursor-wait disabled:opacity-70 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        >
          {pages.map((page) => (
            <option key={page} value={page}>
              Halaman {page}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop: type-to-jump combobox. */}
      {/* noValidate is load-bearing: `max` makes the browser block submission
          of an out-of-range number outright, so `submitDraft` never runs and
          typing 9999 silently does nothing. min/max are kept for the spinner
          bounds and for assistive tech; the clamp in `submitDraft` is what
          actually handles out-of-range input. */}
      <form onSubmit={submitDraft} noValidate className="hidden items-end gap-2 sm:flex">
        <div>
          <label
            htmlFor={`${fieldId}-input`}
            className="block text-xs text-zinc-600 dark:text-zinc-400"
          >
            Ke halaman
          </label>
          <input
            id={`${fieldId}-input`}
            ref={inputRef}
            list={listId}
            type="number"
            inputMode="numeric"
            min={1}
            max={totalPages}
            value={draft}
            disabled={isPending}
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby={`${fieldId}-range`}
            className="mt-1 h-9 w-28 rounded-md border border-zinc-300 bg-white px-2 text-sm tabular-nums text-zinc-900 disabled:cursor-wait disabled:opacity-70 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          {/* The datalist is what makes typing "150" surface "Halaman 150".
              One <option> per page is deliberate here even though this list
              scales with book length (CLAUDE.md warns about that): these are
              text-only leaf nodes with no handlers, and the popup is the
              browser's own virtualised list — the cost a windowed page-number
              list avoids is per-interactive-element, which this has none of. */}
          <datalist id={listId}>
            {pages.map((page) => (
              <option key={page} value={page} label={`Halaman ${page}`} />
            ))}
          </datalist>
        </div>

        <span id={`${fieldId}-range`} className="sr-only">
          Masukkan nomor halaman antara 1 dan {totalPages}
        </span>

        <button
          type="submit"
          disabled={isPending}
          className="h-9 rounded-md border border-zinc-300 px-3 text-sm text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-70 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Buka
        </button>
      </form>
    </div>
  );
}
