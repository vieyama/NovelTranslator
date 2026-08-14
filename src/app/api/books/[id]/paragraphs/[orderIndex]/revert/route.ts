import { BookAccessError } from "@/lib/ownership";
import { ProgressUpdateError, revertTranslation } from "@/lib/reader";
import { UnauthorizedError, requireApiUser } from "@/lib/session";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string; orderIndex: string }> };

/**
 * POST /api/books/:id/paragraphs/:orderIndex/revert — restore the previous
 * translation of one paragraph (SPEC.md §3.6).
 *
 * Undo for re-translation. Scoped per paragraph rather than per batch, so a
 * re-translated run where only some paragraphs came out worse can be fixed
 * without discarding the ones that improved.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  const { id, orderIndex } = await params;

  const parsed = Number.parseInt(orderIndex, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return Response.json({ error: "`orderIndex` must be a non-negative integer." }, { status: 400 });
  }

  try {
    const user = await requireApiUser();
    const paragraph = await revertTranslation(id, user.id, parsed);

    return Response.json({ paragraph });
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      error instanceof BookAccessError ||
      error instanceof ProgressUpdateError
    ) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to revert translation:", error);
    return Response.json({ error: "Gagal mengembalikan terjemahan." }, { status: 500 });
  }
}
