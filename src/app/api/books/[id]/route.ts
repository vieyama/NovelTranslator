import { BookImportError, deleteBook } from "@/lib/books";
import { UnauthorizedError, requireApiUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * DELETE /api/books/:id — remove a book (SPEC.md §4).
 *
 * Cascades to paragraphs, progress, and glossary terms. Irreversible — the
 * translated text is gone with it, so the UI confirms before calling this.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const user = await requireApiUser();
    const { title } = await deleteBook(id, user.id);

    return Response.json({ deleted: { id, title } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof BookImportError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to delete book:", error);
    return Response.json({ error: "Failed to delete book." }, { status: 500 });
  }
}
