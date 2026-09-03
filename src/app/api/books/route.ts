import { BookImportError, createBookFromUpload, listBooksWithProgress } from "@/lib/books";
import { UnauthorizedError, requireApiUser } from "@/lib/session";

// pg needs Node's TCP/TLS sockets, so this route cannot run on the edge.
export const runtime = "nodejs";

/** GET /api/books — library list with progress summary (SPEC.md §4). */
export async function GET() {
  try {
    const user = await requireApiUser();

    return Response.json({ books: await listBooksWithProgress(user.id) });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to list books:", error);
    return Response.json({ error: "Failed to list books." }, { status: 500 });
  }
}

/**
 * POST /api/books — upload & parse a novel.
 *
 * Expects multipart/form-data:
 *   file   (required) the .txt, .epub, or .pdf file
 *   title  (optional) defaults to the filename without its extension
 *   author (optional)
 */
export async function POST(request: Request) {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected a multipart/form-data request with a `file` field." },
      { status: 400 },
    );
  }

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "Missing `file` field." }, { status: 400 });
  }

  try {
    const user = await requireApiUser();
    const book = await createBookFromUpload({
      userId: user.id,
      file,
      title: asString(formData.get("title")),
      author: asString(formData.get("author")),
    });

    return Response.json(
      {
        book: {
          id: book.id,
          title: book.title,
          author: book.author,
          sourceFormat: book.sourceFormat,
          totalParagraphs: book.totalParagraphs,
          createdAt: book.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof BookImportError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to import book:", error);
    return Response.json({ error: "Failed to import book." }, { status: 500 });
  }
}

function asString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" ? value : null;
}
