import { GlossaryError, createGlossaryTerm, listGlossaryTerms } from "@/lib/glossary";

export const runtime = "nodejs";

/** GET /api/books/:id/glossary — list this book's terms. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    return Response.json({ terms: await listGlossaryTerms(id) });
  } catch (error) {
    return toResponse(error, "Failed to load glossary.");
  }
}

/**
 * POST /api/books/:id/glossary — add a term.
 *
 * Body: { term, translation?, category?, note? }
 * A null/empty `translation` means "keep unchanged" (GLOSSARY.md).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const term = await createGlossaryTerm(id, (body ?? {}) as Record<string, unknown>);

    return Response.json({ term }, { status: 201 });
  } catch (error) {
    return toResponse(error, "Failed to add glossary term.");
  }
}

function toResponse(error: unknown, fallback: string): Response {
  if (error instanceof GlossaryError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 500 });
}
