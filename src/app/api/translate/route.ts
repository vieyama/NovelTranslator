import { resolveProvider } from "@/lib/translator/provider";
import { translateNextBatch } from "@/lib/translator/translateNextBatch";
import { TranslationError } from "@/lib/translator/types";

// pg needs Node's TCP/TLS sockets (no edge runtime support), and batches can
// take a while to translate.
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/translate — translate the next batch of a book (SPEC.md §3.2).
 *
 * Body (JSON): { bookId: string, maxChars?: number, fromIndex?: number }
 *
 * `fromIndex` jumps the batch to start at that paragraph instead of
 * continuing from `lastTranslatedIndex` — any still-untranslated paragraphs
 * left behind stay that way until a later call fills them in.
 *
 * On any failure the response is a non-2xx and `lastTranslatedIndex` is left
 * exactly where it was, so the same batch can simply be retried.
 */
export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body with a `bookId`." }, { status: 400 });
  }

  const { bookId, maxChars, fromIndex } = (body ?? {}) as {
    bookId?: unknown;
    maxChars?: unknown;
    fromIndex?: unknown;
  };

  if (typeof bookId !== "string" || bookId.trim() === "") {
    return Response.json({ error: "`bookId` is required." }, { status: 400 });
  }

  if (maxChars !== undefined && (typeof maxChars !== "number" || !Number.isFinite(maxChars))) {
    return Response.json({ error: "`maxChars` must be a number." }, { status: 400 });
  }

  if (fromIndex !== undefined && (typeof fromIndex !== "number" || !Number.isFinite(fromIndex))) {
    return Response.json({ error: "`fromIndex` must be a number." }, { status: 400 });
  }

  try {
    // Provider comes from TRANSLATION_PROVIDER; everything after this point is
    // identical for Claude and Gemini.
    const provider = resolveProvider();
    const result = await translateNextBatch({
      bookId: bookId.trim(),
      maxChars,
      fromIndex,
      provider,
    });

    return Response.json(result);
  } catch (error) {
    if (error instanceof TranslationError) {
      return Response.json(
        { error: error.message, code: error.code, progressAdvanced: false },
        { status: error.status },
      );
    }

    console.error("Translation batch failed:", error);
    return Response.json(
      { error: "Translation failed.", code: "provider_error", progressAdvanced: false },
      { status: 500 },
    );
  }
}
