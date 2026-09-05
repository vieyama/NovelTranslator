import { BookAccessError } from "@/lib/ownership";
import { ProgressUpdateError, updateParagraphText } from "@/lib/reader";
import { UnauthorizedError, requireApiUser } from "@/lib/session";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string; orderIndex: string }> };

/**
 * PATCH /api/books/:id/paragraphs/:orderIndex — manually edit source and/or
 * translated paragraph text.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, orderIndex } = await params;
  const parsed = Number.parseInt(orderIndex, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return Response.json({ error: "`orderIndex` must be a non-negative integer." }, { status: 400 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const user = await requireApiUser();
    const result = await updateParagraphText(id, user.id, parsed, (body ?? {}) as object);

    return Response.json(result);
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      error instanceof BookAccessError ||
      error instanceof ProgressUpdateError
    ) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to update paragraph:", error);
    return Response.json({ error: "Gagal menyimpan perubahan paragraf." }, { status: 500 });
  }
}
