import Link from "next/link";
import { notFound } from "next/navigation";

import { GlossaryEditor } from "@/components/glossary/GlossaryEditor";
import { prisma } from "@/lib/db";
import { listGlossaryTerms } from "@/lib/glossary";

export const dynamic = "force-dynamic";

/** Glossary editor for one book (GLOSSARY.md, TASKS.md Phase 6). */
export default async function GlossaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const book = await prisma.book.findUnique({
    where: { id },
    select: { id: true, title: true },
  });

  if (!book) notFound();

  const terms = await listGlossaryTerms(book.id);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <Link
        href={`/books/${book.id}`}
        className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        ← {book.title}
      </Link>

      <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Glosarium</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-500">
        Istilah di sini dikirim ke AI pada setiap batch terjemahan, jadi nama tokoh dan istilah
        khusus tetap konsisten dari awal sampai akhir novel. Mengubah glosarium{" "}
        <strong className="font-medium">tidak</strong> menulis ulang paragraf yang sudah
        diterjemahkan.
      </p>

      <div className="mt-8">
        <GlossaryEditor bookId={book.id} terms={terms} />
      </div>
    </div>
  );
}
