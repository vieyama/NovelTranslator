"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// From the schema module, not `@/lib/reader` — that one imports Prisma.
import type { ReaderPage } from "@/lib/reader-schema";

import { ParagraphBlock } from "./ParagraphBlock";
import { TranslateBatchButton } from "./TranslateBatchButton";
import {
  VIEW_MODES,
  getViewModeServerSnapshot,
  getViewModeSnapshot,
  setViewMode,
  subscribeViewMode,
} from "./types";

/**
 * Interactive shell of the reader (SPEC.md §3.3).
 *
 * The paragraph window itself is chosen on the server from `lastReadIndex + 1`;
 * this component owns the view mode, the mark-read action, and the inline
 * translate button.
 */
export function ReaderView({ page }: { page: ReaderPage }) {
  const router = useRouter();
  const [markingIndex, setMarkingIndex] = useState<number | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Reads the persisted mode without a setState-in-effect: the server renders
  // the default, then hydration picks up whatever was last chosen.
  const viewMode = useSyncExternalStore(
    subscribeViewMode,
    getViewModeSnapshot,
    getViewModeServerSnapshot,
  );

  async function markRead(orderIndex: number) {
    setMarkingIndex(orderIndex);
    setMarkError(null);

    try {
      const response = await fetch(`/api/books/${page.book.id}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastReadIndex: orderIndex }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setMarkError(payload.error ?? "Gagal menyimpan posisi baca.");
        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setMarkError("Tidak bisa menghubungi server.");
    } finally {
      setMarkingIndex(null);
    }
  }

  const { book, progress, paragraphs, window: pageWindow } = page;

  // Where the translate prompt belongs: the first untranslated paragraph that
  // is actually on screen.
  const firstUntranslatedOnScreen = paragraphs.find((p) => p.translatedText === null)?.orderIndex;

  const lastOnScreen = paragraphs.at(-1)?.orderIndex;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6 sm:px-6">
      <header className="border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-4">
          <Link
            href="/books"
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            ← Perpustakaan
          </Link>

          <Link
            href={`/books/${book.id}/glossary`}
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            Glosarium →
          </Link>
        </div>

        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{book.title}</h1>
        {book.author && <p className="text-sm text-zinc-500">{book.author}</p>}

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
          <div className="flex gap-1">
            <dt>Dibaca:</dt>
            <dd className="tabular-nums">
              {progress.lastReadIndex + 1} / {book.totalParagraphs}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Diterjemahkan:</dt>
            <dd className="tabular-nums">
              {page.translatedCount} / {book.totalParagraphs}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Di layar:</dt>
            <dd className="tabular-nums">
              #{pageWindow.from}–#{lastOnScreen ?? pageWindow.from}
            </dd>
          </div>
        </dl>
      </header>

      <div className="sticky top-0 z-10 -mx-4 mb-2 flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950/90">
        <span className="text-xs uppercase tracking-wide text-zinc-500">Tampilan</span>
        {VIEW_MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            onClick={() => setViewMode(mode.value)}
            aria-pressed={viewMode === mode.value}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              viewMode === mode.value
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {markError && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
          {markError}
        </p>
      )}

      {paragraphs.length === 0 ? (
        <p className="py-12 text-center text-zinc-500">Tidak ada paragraf di posisi ini.</p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {paragraphs.map((paragraph) => (
            <div key={paragraph.orderIndex}>
              {paragraph.orderIndex === firstUntranslatedOnScreen && (
                <TranslateBatchButton bookId={book.id} />
              )}

              <ParagraphBlock
                paragraph={paragraph}
                viewMode={viewMode}
                isRead={paragraph.orderIndex <= progress.lastReadIndex}
                isMarking={markingIndex === paragraph.orderIndex}
                onMarkRead={markRead}
              />
            </div>
          ))}
        </div>
      )}

      <nav className="mt-8 flex items-center justify-between gap-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
        {pageWindow.prevFrom !== null ? (
          <Link
            href={`/books/${book.id}?from=${pageWindow.prevFrom}`}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            ← Sebelumnya
          </Link>
        ) : (
          <span />
        )}

        {lastOnScreen !== undefined && lastOnScreen > progress.lastReadIndex && (
          <button
            type="button"
            onClick={() => markRead(lastOnScreen)}
            disabled={markingIndex !== null}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-70"
          >
            {markingIndex === lastOnScreen
              ? "Menyimpan…"
              : `Tandai sudah dibaca sampai #${lastOnScreen}`}
          </button>
        )}

        {pageWindow.nextFrom !== null ? (
          <Link
            href={`/books/${book.id}?from=${pageWindow.nextFrom}`}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Berikutnya →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}
