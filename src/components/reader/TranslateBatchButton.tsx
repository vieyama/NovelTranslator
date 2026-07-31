"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Inline "translate next batch" control (SPEC.md §3.3).
 *
 * Rendered where the translated text runs out, so the user never has to leave
 * the reader to keep going.
 */
export function TranslateBatchButton({ bookId }: { bookId: string }) {
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
    <div className="my-6 rounded-lg border border-dashed border-amber-400 bg-amber-50/60 p-4 dark:border-amber-700 dark:bg-amber-950/20">
      <p className="text-sm text-amber-900 dark:text-amber-200">
        Paragraf berikutnya belum diterjemahkan.
      </p>

      <button
        type="button"
        onClick={translate}
        disabled={busy}
        className="mt-3 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? "Menerjemahkan…" : "Terjemahkan batch berikutnya"}
      </button>

      {busy && (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          Ini memanggil AI dan bisa memakan waktu sampai beberapa menit. Jangan tutup halaman.
        </p>
      )}

      {lastResult && !busy && (
        <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{lastResult}</p>
      )}

      {error && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error} <span className="text-zinc-500">Progress tidak berubah, aman dicoba lagi.</span>
        </p>
      )}
    </div>
  );
}
