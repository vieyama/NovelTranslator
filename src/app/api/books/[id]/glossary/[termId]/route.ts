import { GlossaryError, deleteGlossaryTerm, updateGlossaryTerm } from "@/lib/glossary";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string; termId: string }> };

/**
 * PATCH /api/books/:id/glossary/:termId — edit a term.
 *
 * Only the fields present in the body are changed, so sending
 * `{ "translation": null }` clears the translation without touching the note.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, termId } = await params;

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const term = await updateGlossaryTerm(id, termId, (body ?? {}) as Record<string, unknown>);

    return Response.json({ term });
  } catch (error) {
    return toResponse(error, "Failed to update glossary term.");
  }
}

/** DELETE /api/books/:id/glossary/:termId */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const { id, termId } = await params;

  try {
    await deleteGlossaryTerm(id, termId);

    return new Response(null, { status: 204 });
  } catch (error) {
    return toResponse(error, "Failed to delete glossary term.");
  }
}

function toResponse(error: unknown, fallback: string): Response {
  if (error instanceof GlossaryError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 500 });
}
