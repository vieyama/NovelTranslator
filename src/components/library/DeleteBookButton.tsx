"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Per-book delete control.
 *
 * Deleting destroys the translated text along with everything else, so the
 * confirm dialog spells that out — this is the one action in the app that
 * throws work away.
 */
export function DeleteBookButton({ bookId, title }: { bookId: string; title: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const confirmed = window.confirm(
      `Hapus "${title}"?\n\nSemua paragraf, terjemahan, progres baca, dan glosariumnya ikut terhapus. Tidak bisa dibatalkan.`,
    );

    if (!confirmed) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/books/${bookId}`, { method: "DELETE" });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error ?? "Gagal menghapus.");
        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError("Tidak bisa menghubungi server.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={remove}
        disabled={isDeleting}
        className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        {isDeleting ? "Menghapus…" : "Hapus"}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
