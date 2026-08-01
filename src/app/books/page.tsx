import Link from "next/link";

import { ProgressBar } from "@/components/ProgressBar";
import { BookSortSelect } from "@/components/library/BookSortSelect";
import { DeleteBookButton } from "@/components/library/DeleteBookButton";
import { UploadBookForm } from "@/components/library/UploadBookForm";
import { listBooksWithProgress } from "@/lib/books";
import { parseBookSort } from "@/lib/books-schema";
import { pageForIndex } from "@/lib/reader-schema";

/** Library view (SPEC.md §3.4). Always reads live progress from the DB. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Perpustakaan — Novel Translator" };

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const { sort } = await searchParams;
  const activeSort = parseBookSort(sort);
  const books = await listBooksWithProgress(activeSort);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Perpustakaan</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {books.length} buku · progres tersimpan otomatis per paragraf.
      </p>

      <div className="mt-6">
        <UploadBookForm />
      </div>

      {/* Nothing to reorder with a single book, so the control only earns its
          space once there are at least two. */}
      {books.length > 1 && (
        <div className="mt-8 flex justify-end">
          <BookSortSelect value={activeSort} />
        </div>
      )}

      {books.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
          <p className="text-zinc-600 dark:text-zinc-400">Belum ada buku.</p>
          <p className="mt-2 text-sm text-zinc-500">
            Unggah novel <code className="font-mono">.txt</code> atau{" "}
            <code className="font-mono">.epub</code> lewat form di atas untuk mulai.
          </p>
        </div>
      ) : (
        // The sort control, when shown, already supplies the gap below the
        // upload form — so the list only needs the full margin without it.
        <ul className={`${books.length > 1 ? "mt-4" : "mt-8"} space-y-4`}>
          {books.map((book) => {
            // Where translation should pick up; also where the inline
            // "translate next batch" button lives in the reader.
            const continueTranslatingFrom = book.lastTranslatedIndex + 1;
            const hasUntranslated = book.translatedCount < book.totalParagraphs;

            return (
              <li
                key={book.id}
                className="rounded-lg border border-zinc-200 p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-50">
                    <Link href={`/books/${book.id}`} className="hover:underline">
                      {book.title}
                    </Link>
                  </h2>
                  <span className="text-xs uppercase tracking-wide text-zinc-400">
                    {book.sourceFormat}
                  </span>
                </div>

                {book.author && <p className="text-sm text-zinc-500">{book.author}</p>}

                <div className="mt-4">
                  <ProgressBar
                    translatedPercent={book.translatedPercent}
                    readPercent={book.readPercent}
                  />
                  <p className="mt-2 flex flex-wrap gap-x-4 text-xs text-zinc-500">
                    <span className="tabular-nums">
                      Diterjemahkan {book.translatedCount}/{book.totalParagraphs} (
                      {book.translatedPercent}%)
                    </span>
                    <span className="tabular-nums">
                      Dibaca {book.lastReadIndex + 1}/{book.totalParagraphs} ({book.readPercent}%)
                    </span>
                  </p>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    href={`/books/${book.id}`}
                    className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    {book.lastReadIndex >= 0 ? "Lanjut membaca" : "Mulai membaca"}
                  </Link>

                  {hasUntranslated && (
                    <Link
                      href={`/books/${book.id}?page=${pageForIndex(continueTranslatingFrom)}`}
                      className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      Lanjut menerjemahkan
                    </Link>
                  )}

                  <span className="ml-auto">
                    <DeleteBookButton bookId={book.id} title={book.title} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
