"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  BOOK_SORT_OPTIONS,
  hrefForBookSort,
  parseBookSort,
  type BookSort,
} from "@/lib/books-schema";

/**
 * Sort control for the library list.
 *
 * The selected sort lives in the URL (`?sort=`), not in component state, so the
 * server re-derives the order from the query on every navigation and a sorted
 * library stays bookmarkable — the same rule the reader's `?page=` follows
 * (CLAUDE.md → "Navigable state lives in the URL"). This component holds no
 * copy of the value; `value` is whatever the server parsed out of the URL.
 *
 * `router.push` inside a transition means the select stays interactive while
 * the server component re-renders, and `isPending` disables it so a second
 * change can't race the first.
 */
export function BookSortSelect({ value }: { value: BookSort }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
      Urutkan
      <select
        value={value}
        disabled={isPending}
        onChange={(event) => {
          // parseBookSort rather than a cast: the value came out of the DOM, and
          // this keeps the fallback identical to the server's.
          const next = parseBookSort(event.target.value);
          startTransition(() => router.push(hrefForBookSort(next)));
        }}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 disabled:cursor-wait disabled:opacity-70 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        {BOOK_SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
