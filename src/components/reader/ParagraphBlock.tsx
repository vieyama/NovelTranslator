"use client";

// From the schema module, not `@/lib/reader` — that one imports Prisma.
import type { ReaderParagraph } from "@/lib/reader-schema";

import { TranslateFromHereButton } from "./TranslateFromHereButton";
import type { ViewMode } from "./types";

/**
 * One paragraph, plus the explicit "mark read up to here" control.
 *
 * Marking is a button rather than scroll tracking — the simpler option, chosen
 * first per TASKS.md Phase 4.
 */
export function ParagraphBlock({
  bookId,
  paragraph,
  viewMode,
  isRead,
  isMarking,
  onMarkRead,
}: {
  bookId: string;
  paragraph: ReaderParagraph;
  viewMode: ViewMode;
  isRead: boolean;
  isMarking: boolean;
  onMarkRead: (orderIndex: number) => void;
}) {
  const showOriginal = viewMode === "original" || viewMode === "side-by-side";
  const showTranslated = viewMode === "translated" || viewMode === "side-by-side";

  return (
    <article
      id={`p-${paragraph.orderIndex}`}
      className={`group scroll-mt-24 rounded-lg border-l-2 py-3 pl-4 pr-2 transition-colors ${
        isRead
          ? "border-emerald-500/70 bg-emerald-50/40 dark:bg-emerald-950/20"
          : "border-transparent hover:border-zinc-300 dark:hover:border-zinc-700"
      }`}
    >
      <div
        className={
          viewMode === "side-by-side"
            ? "grid gap-x-8 gap-y-2 md:grid-cols-2"
            : "space-y-2"
        }
      >
        {showOriginal && (
          <p
            lang="en"
            className={`text-[0.975rem] leading-relaxed ${
              viewMode === "side-by-side"
                ? "text-zinc-500 dark:text-zinc-400"
                : "text-zinc-800 dark:text-zinc-200"
            }`}
          >
            {paragraph.originalText}
          </p>
        )}

        {showTranslated &&
          (paragraph.translatedText ? (
            <p lang="id" className="text-[1.0625rem] leading-relaxed text-zinc-900 dark:text-zinc-100">
              {paragraph.translatedText}
            </p>
          ) : (
            <div>
              <p className="text-sm italic text-amber-700 dark:text-amber-400">
                Belum diterjemahkan.
                {viewMode === "translated" && " Ganti ke mode “Asli” untuk membaca teks sumbernya."}
              </p>
              <TranslateFromHereButton bookId={bookId} orderIndex={paragraph.orderIndex} />
            </div>
          ))}
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs">
        <span className="tabular-nums text-zinc-400 dark:text-zinc-600">
          #{paragraph.orderIndex}
        </span>

        {isRead ? (
          <span className="text-emerald-700 dark:text-emerald-400">Sudah dibaca</span>
        ) : (
          <button
            type="button"
            onClick={() => onMarkRead(paragraph.orderIndex)}
            disabled={isMarking}
            className="rounded text-zinc-400 opacity-0 transition-opacity hover:text-emerald-700 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 group-hover:opacity-100 disabled:cursor-wait dark:hover:text-emerald-400"
          >
            {isMarking ? "Menyimpan…" : "Tandai sudah dibaca sampai sini"}
          </button>
        )}
      </div>
    </article>
  );
}
