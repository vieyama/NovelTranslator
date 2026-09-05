"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { readApiError } from "@/components/reader/apiError";

type EditingField = "originalText" | "translatedText";

export function ParagraphTextEditor({
  bookId,
  orderIndex,
  originalText,
  translatedText,
}: {
  bookId: string;
  orderIndex: number;
  originalText: string;
  translatedText: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<EditingField | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isSaving, setIsSaving] = useState(false);

  const busy = isPending || isSaving;

  function startEdit(field: EditingField) {
    setEditing(field);
    setValue(field === "originalText" ? originalText : translatedText ?? "");
    setError(null);
  }

  async function save() {
    if (!editing) return;

    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/books/${bookId}/paragraphs/${orderIndex}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [editing]: value }),
      });
      const payload = await response.clone().json().catch(() => ({}));

      if (!response.ok) {
        setError(await readApiError(response, payload, "Gagal menyimpan paragraf."));
        return;
      }

      setEditing(null);
      startTransition(() => router.refresh());
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? `Tidak bisa menghubungi server: ${saveError.message}`
          : "Tidak bisa menghubungi server.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  if (editing) {
    return (
      <span className="basis-full pt-2">
        <label className="block text-xs font-medium text-zinc-500">
          {editing === "originalText" ? "Edit teks asli" : "Edit terjemahan"}
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={5}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>

        <span className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {busy ? "Menyimpan..." : "Simpan"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-70 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Batal
          </button>
          {editing === "translatedText" && (
            <span className="text-xs text-zinc-500">Kosongkan untuk menghapus terjemahan.</span>
          )}
        </span>

        {error && <span className="mt-2 block text-xs text-red-700 dark:text-red-400">{error}</span>}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => startEdit("originalText")}
        className="rounded cursor-pointer text-zinc-400 transition-colors hover:text-sky-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:hover:text-sky-400"
      >
        Edit asli
      </button>
      <button
        type="button"
        onClick={() => startEdit("translatedText")}
        className="rounded cursor-pointer text-zinc-400 transition-colors hover:text-sky-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:hover:text-sky-400"
      >
        Edit terjemahan
      </button>
    </>
  );
}
