// Server-only: Prisma.
import "server-only";

import { prisma } from "@/lib/db";

/**
 * The one gate between a `bookId` from a request and the rows behind it.
 *
 * Books belong to users (SPEC.md §8), and nothing in a URL proves ownership —
 * book ids are guessable enough that "unlisted" is not a boundary. Every
 * entry point that accepts a book id calls this before touching paragraphs,
 * progress, or glossary terms, so scoping lives in one auditable place rather
 * than being re-derived (and eventually forgotten) in each query.
 *
 * **Missing and not-yours are both 404, deliberately.** A 403 would confirm
 * that some other account owns that id, which is exactly the fact a probe is
 * looking for. The caller cannot tell the two apart, and shouldn't.
 */
export class BookAccessError extends Error {
  readonly status = 404;

  constructor(bookId: string) {
    super(`Book ${bookId} not found.`);
    this.name = "BookAccessError";
  }
}

/** Throws `BookAccessError` unless `userId` owns `bookId`. */
export async function assertBookOwned(bookId: string, userId: string): Promise<void> {
  const book = await prisma.book.findFirst({
    where: { id: bookId, userId },
    select: { id: true },
  });

  if (!book) throw new BookAccessError(bookId);
}

/** Non-throwing variant, for reads that render "not found" rather than erroring. */
export async function isBookOwned(bookId: string, userId: string): Promise<boolean> {
  const book = await prisma.book.findFirst({
    where: { id: bookId, userId },
    select: { id: true },
  });

  return book !== null;
}
