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
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;

  // No `from` in the URL means "resume": getReaderPage falls back to
  // lastReadIndex + 1.
  const parsedFrom = from === undefined ? undefined : Number.parseInt(from, 10);
  const requestedFrom =
    parsedFrom !== undefined && Number.isFinite(parsedFrom) ? parsedFrom : undefined;

  const page = await getReaderPage(id, requestedFrom);

  if (!page) notFound();

  return <ReaderView page={page} />;
}
