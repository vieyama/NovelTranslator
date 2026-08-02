import { notFound } from "next/navigation";

import { ReaderView } from "@/components/reader/ReaderView";
import { getReaderPage } from "@/lib/reader";
import { requireUser } from "@/lib/session";

/** Reader view (SPEC.md §3.3). Progress must always be read fresh. */
export const dynamic = "force-dynamic";

export default async function BookReaderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/books/${id}`);
  const { page: pageParam } = await searchParams;

  // No `page` in the URL means "resume": getReaderPage falls back to the page
  // containing lastReadIndex + 1.
  const parsedPage = pageParam === undefined ? undefined : Number.parseInt(pageParam, 10);
  const requestedPage = parsedPage !== undefined && Number.isFinite(parsedPage) ? parsedPage : undefined;

  // Returns null both when the book doesn't exist and when it belongs to
  // someone else — the reader renders notFound() either way (SPEC.md §8).
  const page = await getReaderPage(id, user.id, requestedPage);

  if (!page) notFound();

  return <ReaderView page={page} />;
}
