import { ProgressUpdateError, setLastReadIndex } from "@/lib/reader";
import { UnauthorizedError, requireApiUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * PATCH /api/books/:id/progress — move the reading position (SPEC.md §4).
 *
 * Body (JSON): { lastReadIndex: number }
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Expected a JSON body with a `lastReadIndex`." },
      { status: 400 },
    );
  }

  const { lastReadIndex } = (body ?? {}) as { lastReadIndex?: unknown };

  if (typeof lastReadIndex !== "number" || !Number.isFinite(lastReadIndex)) {
    return Response.json({ error: "`lastReadIndex` must be a number." }, { status: 400 });
  }

  try {
    const user = await requireApiUser();
    const progress = await setLastReadIndex(id, user.id, lastReadIndex);

    return Response.json({ progress });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof ProgressUpdateError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to update reading progress:", error);
    return Response.json({ error: "Failed to update reading progress." }, { status: 500 });
  }
}
