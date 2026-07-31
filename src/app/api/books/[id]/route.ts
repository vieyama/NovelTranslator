import { BookImportError, deleteBook } from "@/lib/books";

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
    const { title } = await deleteBook(id);

    return Response.json({ deleted: { id, title } });
  } catch (error) {
    if (error instanceof BookImportError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to delete book:", error);
    return Response.json({ error: "Failed to delete book." }, { status: 500 });
  }
}
