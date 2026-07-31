import { notFound } from "next/navigation";

import { ReaderView } from "@/components/reader/ReaderView";
import { getReaderPage } from "@/lib/reader";

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
  const { page: pageParam } = await searchParams;

  // No `page` in the URL means "resume": getReaderPage falls back to the page
  // containing lastReadIndex + 1.
  const parsedPage = pageParam === undefined ? undefined : Number.parseInt(pageParam, 10);
  const requestedPage = parsedPage !== undefined && Number.isFinite(parsedPage) ? parsedPage : undefined;

  const page = await getReaderPage(id, requestedPage);

  if (!page) notFound();

  return <ReaderView page={page} />;
}
