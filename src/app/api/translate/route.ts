import { AiSettingsError } from "@/lib/ai-settings";
import { UnauthorizedError, requireApiUser } from "@/lib/session";
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
    const user = await requireApiUser();

    // Provider, model and API key all come from this user's settings (falling
    // back to the server env vars); everything after this point is identical
    // for Claude and Gemini.
    const result = await translateNextBatch({
      bookId: bookId.trim(),
      userId: user.id,
      maxChars,
      fromIndex,
    });

    return Response.json(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json(
        { error: error.message, code: "unauthorized", progressAdvanced: false },
        { status: error.status },
      );
    }

    // A missing or undecryptable API key is a setup problem the user can fix
    // in Settings, so it keeps its own message rather than becoming a 500.
    if (error instanceof AiSettingsError) {
      return Response.json(
        { error: error.message, code: "missing_api_key", progressAdvanced: false },
        { status: error.status },
      );
    }

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
