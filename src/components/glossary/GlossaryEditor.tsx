"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Imported from the schema module, not `@/lib/glossary` — that one pulls in
// Prisma and would drag a native binding into the browser bundle.
import { GLOSSARY_CATEGORIES, type GlossaryTermRecord } from "@/lib/glossary-schema";

/**
 * Glossary editor for one book (GLOSSARY.md → Workflow).
 *
 * Terms added here are injected into every subsequent translation batch, for
 * whichever provider is configured. Existing translations are deliberately not
 * rewritten — that would silently change text the user has already read.
 */
export function GlossaryEditor({
  bookId,
  terms,
}: {
  bookId: string;
  terms: GlossaryTermRecord[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  async function send(url: string, init: RequestInit): Promise<boolean> {
    setError(null);

    try {
      const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error ?? "Gagal menyimpan.");
        return false;
      }

      startTransition(() => router.refresh());
      return true;
    } catch {
      setError("Tidak bisa menghubungi server.");
      return false;
    }
  }

  async function addTerm(form: FormData) {
    setIsAdding(true);

    const ok = await send(`/api/books/${bookId}/glossary`, {
      method: "POST",
      body: JSON.stringify(fieldsFrom(form)),
    });

    setIsAdding(false);
    return ok;
  }

  async function saveTerm(termId: string, form: FormData) {
    setBusyId(termId);

    if (await send(`/api/books/${bookId}/glossary/${termId}`, {
      method: "PATCH",
      body: JSON.stringify(fieldsFrom(form)),
    })) {
      setEditingId(null);
    }

    setBusyId(null);
  }

  async function removeTerm(termId: string, term: string) {
    if (!window.confirm(`Hapus "${term}" dari glosarium?`)) return;

    setBusyId(termId);
    await send(`/api/books/${bookId}/glossary/${termId}`, { method: "DELETE" });
    setBusyId(null);
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </p>
      )}

      <form
        action={async (form) => {
          if (await addTerm(form)) {
            (document.getElementById("add-glossary-term") as HTMLFormElement | null)?.reset();
          }
        }}
        id="add-glossary-term"
        className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Tambah istilah</h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Istilah asli" name="term" required placeholder="Arthur" />
          <Field
            label="Terjemahan"
            name="translation"
            placeholder="kosongkan = biarkan apa adanya"
          />
          <Field label="Kategori" name="category" list="glossary-categories" placeholder="character" />
          <Field label="Catatan" name="note" placeholder="opsional" />
        </div>

        <datalist id="glossary-categories">
          {GLOSSARY_CATEGORIES.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>

        <button
          type="submit"
          disabled={isAdding}
          className="mt-4 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {isAdding ? "Menyimpan…" : "Tambah"}
        </button>
      </form>

      {terms.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Belum ada istilah. Tambahkan nama tokoh, tempat, atau skill yang harus konsisten di
          seluruh novel.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {terms.map((term) =>
            editingId === term.id ? (
              <li key={term.id} className="p-4">
                <form action={(form) => saveTerm(term.id, form)}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Istilah asli" name="term" required defaultValue={term.term} />
                    <Field
                      label="Terjemahan"
                      name="translation"
                      defaultValue={term.translation ?? ""}
                      placeholder="kosongkan = biarkan apa adanya"
                    />
                    <Field
                      label="Kategori"
                      name="category"
                      list="glossary-categories"
                      defaultValue={term.category ?? ""}
                    />
                    <Field label="Catatan" name="note" defaultValue={term.note ?? ""} />
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button
                      type="submit"
                      disabled={busyId === term.id}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-70"
                    >
                      {busyId === term.id ? "Menyimpan…" : "Simpan"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      Batal
                    </button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={term.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="text-sm">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{term.term}</span>
                    <span className="text-zinc-400"> → </span>
                    {term.translation ? (
                      <span className="text-zinc-800 dark:text-zinc-200">{term.translation}</span>
                    ) : (
                      <span className="italic text-zinc-500">biarkan apa adanya</span>
                    )}
                  </p>

                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-500">
                    {term.category && (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                        {term.category}
                      </span>
                    )}
                    {term.note && <span>{term.note}</span>}
                  </p>
                </div>

                <div className="flex shrink-0 gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => setEditingId(term.id)}
                    className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    Ubah
                  </button>
                  <button
                    type="button"
                    onClick={() => removeTerm(term.id, term.term)}
                    disabled={busyId === term.id}
                    className="text-red-600 hover:text-red-700 disabled:cursor-wait disabled:opacity-60 dark:text-red-400"
                  >
                    {busyId === term.id ? "…" : "Hapus"}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function Field({
  label,
  name,
  ...input
}: { label: string; name: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-xs text-zinc-600 dark:text-zinc-400">
      {label}
      <input
        name={name}
        {...input}
        className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
    </label>
  );
}

/** Empty inputs become `null` so the API reads them as "no value". */
function fieldsFrom(form: FormData) {
  const read = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };

  return {
    term: read("term"),
    translation: read("translation"),
    category: read("category"),
    note: read("note"),
  };
}
