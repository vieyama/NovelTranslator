"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { describeTranslationSource } from "@/lib/reader-schema";

/**
 * Re-translate / undo controls for one already-translated paragraph
 * (SPEC.md §3.6).
 *
 * Re-translation runs a **batch** forward from this paragraph, not just this
 * one. A paragraph translated alone gets less surrounding context than it had
 * originally, which tends to shift register and word choice away from its
 * neighbours — redoing it to improve quality while removing context works
 * against itself. The label says so outright rather than leaving the scope to
 * be inferred from where the button sits, which has misled here before.
 *
 * Undo is per paragraph regardless, so a batch where only some paragraphs came
 * out worse can be fixed without discarding the ones that improved.
 */
export function RetranslateControls({
  bookId,
  orderIndex,
  translatedBy,
  hasPreviousVersion,
}: {
  bookId: string;
  orderIndex: number;
  translatedBy: string | null;
  hasPreviousVersion: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "retranslate" | "revert">(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const working = busy !== null || isPending;
  const source = describeTranslationSource(translatedBy);

  async function retranslate() {
    setBusy("retranslate");
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, fromIndex: orderIndex, retranslate: true }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // The API guarantees the previous text is untouched on failure.
        setError(payload.error ?? "Terjemahan ulang gagal.");
        return;
      }

      setResult(
        `${payload.paragraphs?.length ?? 0} paragraf diterjemahkan ulang dengan ${payload.model}.`,
      );
      startTransition(() => router.refresh());
    } catch {
      setError("Tidak bisa menghubungi server.");
    } finally {
      setBusy(null);
    }
  }

  async function revert() {
    setBusy("revert");
    setError(null);
    setResult(null);

    try {
      const response = await fetch(
        `/api/books/${bookId}/paragraphs/${orderIndex}/revert`,
        { method: "POST" },
      );

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.error ?? "Gagal mengembalikan terjemahan.");
        return;
      }

      setResult("Versi sebelumnya dikembalikan.");
      startTransition(() => router.refresh());
    } catch {
      setError("Tidak bisa menghubungi server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {source && (
        <span className="text-zinc-400 dark:text-zinc-600" title={translatedBy ?? undefined}>
          via {source}
        </span>
      )}

      <button
        type="button"
        onClick={retranslate}
        disabled={working}
        title={`Menerjemahkan ulang satu batch mulai dari paragraf #${orderIndex}`}
        className="rounded text-zinc-400 underline-offset-2 transition-colors hover:text-amber-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-wait dark:hover:text-amber-400"
      >
        {busy === "retranslate" ? "Menerjemahkan ulang…" : "Terjemahkan ulang dari sini"}
      </button>

      {/* Only rendered where an undo actually exists, so it isn't permanent
          clutter on every paragraph. */}
      {hasPreviousVersion && (
        <button
          type="button"
          onClick={revert}
          disabled={working}
          title="Tukar dengan versi terjemahan sebelumnya"
          className="rounded text-zinc-400 underline-offset-2 transition-colors hover:text-emerald-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-wait dark:hover:text-emerald-400"
        >
          {busy === "revert" ? "Mengembalikan…" : "↩ Versi sebelumnya"}
        </button>
      )}

      {result && !working && (
        <span className="text-emerald-700 dark:text-emerald-400">{result}</span>
      )}

      {error && (
        <span role="alert" className="text-red-700 dark:text-red-400">
          {error} <span className="text-zinc-500">Teks lama tidak berubah.</span>
        </span>
      )}
    </span>
  );
}
