"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Per-paragraph "translate starting here" trigger (SPEC.md §3.2).
 *
 * Unlike `TranslateBatchButton` (which always continues from the watermark),
 * this jumps translation ahead to wherever the reader is, skipping over any
 * untranslated paragraphs still sitting behind it — those stay untranslated
 * until a later batch (the banner, or another one of these) fills them in.
 */
export function TranslateFromHereButton({
  bookId,
  orderIndex,
}: {
  bookId: string;
  orderIndex: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = isRequesting || isPending;

  async function translate() {
    setIsRequesting(true);
    setError(null);

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, fromIndex: orderIndex }),
      });

      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Terjemahan gagal.");
        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError("Tidak bisa menghubungi server.");
    } finally {
      setIsRequesting(false);
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={translate}
        disabled={busy}
        className="rounded cursor-pointer text-xs font-medium text-amber-700 underline decoration-dotted underline-offset-2 hover:text-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-wait disabled:opacity-70 dark:text-amber-400 dark:hover:text-amber-200"
      >
        {busy ? "Menerjemahkan…" : "Terjemahkan dari sini"}
      </button>

      {error && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-400">
          {error} <span className="text-zinc-500">Progress tidak berubah, aman dicoba lagi.</span>
        </p>
      )}
    </div>
  );
}
