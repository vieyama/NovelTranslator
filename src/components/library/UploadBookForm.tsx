"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Upload form for the library page — replaces the curl-only flow from Phase 2.
 *
 * Posts multipart/form-data to POST /api/books; on success the router refresh
 * pulls the new book into the server-rendered list.
 */
export function UploadBookForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [, startTransition] = useTransition();
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function upload(form: FormData) {
    const file = form.get("file");

    if (!(file instanceof File) || file.size === 0) {
      setError("Pilih file .txt atau .epub dulu.");
      return;
    }

    setIsUploading(true);
    setError(null);
    setSuccess(null);

    try {
      // Send only non-empty fields so the API's filename-fallback for the
      // title still applies.
      const body = new FormData();
      body.set("file", file);
      const title = form.get("title");
      const author = form.get("author");
      if (typeof title === "string" && title.trim() !== "") body.set("title", title.trim());
      if (typeof author === "string" && author.trim() !== "") body.set("author", author.trim());

      const response = await fetch("/api/books", { method: "POST", body });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.error ?? "Upload gagal.");
        return;
      }

      setSuccess(
        `"${payload.book.title}" ditambahkan — ${payload.book.totalParagraphs} paragraf.`,
      );
      formRef.current?.reset();
      startTransition(() => router.refresh());
    } catch {
      setError("Tidak bisa menghubungi server.");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <form
      ref={formRef}
      action={upload}
      className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Tambah buku</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block text-xs text-zinc-600 dark:text-zinc-400">
          File novel (.txt / .epub)
          <input
            type="file"
            name="file"
            accept=".txt,.epub"
            required
            className="mt-1 block w-full text-sm text-zinc-700 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:text-zinc-800 hover:file:bg-zinc-200 dark:text-zinc-300 dark:file:bg-zinc-800 dark:file:text-zinc-200 dark:hover:file:bg-zinc-700"
          />
        </label>

        <label className="block text-xs text-zinc-600 dark:text-zinc-400">
          Judul (opsional)
          <input
            type="text"
            name="title"
            placeholder="default: nama file"
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>

        <label className="block text-xs text-zinc-600 dark:text-zinc-400">
          Penulis (opsional)
          <input
            type="text"
            name="author"
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>
      </div>

      <button
        type="submit"
        disabled={isUploading}
        className="mt-4 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {isUploading ? "Mengunggah…" : "Unggah"}
      </button>

      {isUploading && (
        <p className="mt-2 text-xs text-zinc-500">
          File besar butuh beberapa detik untuk diparse.
        </p>
      )}

      {success && (
        <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{success}</p>
      )}

      {error && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </form>
  );
}
