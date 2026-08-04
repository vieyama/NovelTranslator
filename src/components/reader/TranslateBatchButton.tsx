"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * "Translate next batch" control, in the reader header (SPEC.md §3.3).
 *
 * It used to sit inline next to the first untranslated paragraph on screen,
 * which read as "this is the paragraph that will be translated" — but the batch
 * always starts at the first untranslated paragraph in the *whole book*, which
 * can be far earlier. Moving it out of the paragraph flow removes the false
 * implication, and `startIndex` states the real starting point outright rather
 * than leaving it to be inferred from position.
 */
export function TranslateBatchButton({
  bookId,
  startIndex,
}: {
  bookId: string;
  /** First untranslated paragraph in the book — where the batch will begin. */
  startIndex: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const busy = isRequesting || isPending;

  async function translate() {
    setIsRequesting(true);
    setError(null);
    setLastResult(null);

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId }),
      });

      const payload = await response.json();

      if (!response.ok) {
        // The API guarantees progress was not advanced, so retrying is safe.
        setError(payload.error ?? "Terjemahan gagal.");
        return;
      }

      setLastResult(
        payload.done
          ? "Semua paragraf sudah diterjemahkan."
          : `${payload.paragraphs.length} paragraf diterjemahkan.`,
      );

      // Pull the freshly translated text into the server-rendered list.
      startTransition(() => router.refresh());
    } catch {
      setError("Tidak bisa menghubungi server. Cek apakah dev server masih jalan.");
    } finally {
      setIsRequesting(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={translate}
        disabled={busy}
        title={`Batch berikutnya dimulai dari paragraf #${startIndex}`}
        className="rounded-md border border-amber-500 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-wait disabled:opacity-70 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/60"
      >
        {busy ? "Menerjemahkan…" : `Terjemahkan batch dari #${startIndex}`}
      </button>

      {busy && (
        <span role="status" className="text-xs text-amber-800 dark:text-amber-300">
          Memanggil AI, bisa beberapa menit. Jangan tutup halaman.
        </span>
      )}

      {lastResult && !busy && (
        <span className="text-xs text-emerald-700 dark:text-emerald-400">{lastResult}</span>
      )}

      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error} <span className="text-zinc-500">Progress tidak berubah, aman dicoba lagi.</span>
        </span>
      )}
    </span>
  );
}
