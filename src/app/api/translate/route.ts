import { AiSettingsError } from "@/lib/ai-settings";
import { UnauthorizedError, requireApiUser } from "@/lib/session";
import { retranslateBatch, translateNextBatch } from "@/lib/translator/translateNextBatch";
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
 * `fromIndex` jumps the batch to start at that paragraph instead of the latest
 * translated position. Any still-untranslated paragraphs left behind stay that
 * way until a later call fills them in.
 *
 * Validation failures return normal non-2xx JSON. Provider-work responses are
 * streamed with keep-alive whitespace and then a final JSON payload
 * (`ok: true` / `ok: false`) so Cloudflare/reverse proxies do not give up while
 * the provider is still working. On any failure progress is left exactly where
 * it was, so the same batch can simply be retried.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body with a `bookId`." }, { status: 400 });
  }

  const { bookId, maxChars, fromIndex, retranslate } = (body ?? {}) as {
    bookId?: unknown;
    maxChars?: unknown;
    fromIndex?: unknown;
    retranslate?: unknown;
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

  // Re-translation replaces existing text rather than filling a gap, so it
  // must name where it starts — there is no watermark to continue from.
  if (retranslate === true && typeof fromIndex !== "number") {
    return Response.json(
      { error: "`fromIndex` is required when `retranslate` is true." },
      { status: 400 },
    );
  }

  return keepAliveJsonResponse(async () => {
    try {
      const user = await requireApiUser();
      console.info("[translate:start]", {
        requestId,
        userId: user.id,
        bookId: bookId.trim(),
        fromIndex,
        maxChars,
        retranslate: retranslate === true,
      });

      // Provider, model and API key all come from this user's settings (falling
      // back to the server env vars); everything after this point is identical
      // whichever provider is selected.
      if (retranslate === true) {
        const result = await retranslateBatch({
          bookId: bookId.trim(),
          userId: user.id,
          fromIndex: fromIndex as number,
          maxChars,
        });

        console.info("[translate:success]", {
          requestId,
          retranslate: true,
          provider: result.provider,
          model: result.model,
          paragraphs: result.paragraphs.length,
          durationMs: Date.now() - startedAt,
        });

        // `done` and `progress` are deliberately absent: re-translation only
        // replaces existing text, so it does not change translate position.
        return { ok: true, ...result, retranslated: true };
      }

      const result = await translateNextBatch({
        bookId: bookId.trim(),
        userId: user.id,
        maxChars,
        fromIndex,
      });

      console.info("[translate:success]", {
        requestId,
        retranslate: false,
        done: result.done,
        provider: result.provider,
        model: result.model,
        paragraphs: result.paragraphs.length,
        durationMs: Date.now() - startedAt,
      });

      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        console.warn("[translate:error]", {
          requestId,
          code: "unauthorized",
          status: error.status,
          durationMs: Date.now() - startedAt,
        });
        return {
          ok: false,
          error: error.message,
          code: "unauthorized",
          progressAdvanced: false,
          status: error.status,
        };
      }

      // A missing or undecryptable API key is a setup problem the user can fix
      // in Settings, so it keeps its own message rather than becoming a 500.
      if (error instanceof AiSettingsError) {
        console.warn("[translate:error]", {
          requestId,
          code: "missing_api_key",
          status: error.status,
          message: error.message,
          durationMs: Date.now() - startedAt,
        });
        return {
          ok: false,
          error: error.message,
          code: "missing_api_key",
          progressAdvanced: false,
          status: error.status,
        };
      }

      if (error instanceof TranslationError) {
        console.warn("[translate:error]", {
          requestId,
          code: error.code,
          status: error.status,
          message: error.message,
          durationMs: Date.now() - startedAt,
        });
        return {
          ok: false,
          error: error.message,
          code: error.code,
          progressAdvanced: false,
          status: error.status,
        };
      }

      console.error("[translate:error]", {
        requestId,
        code: "provider_error",
        status: 500,
        durationMs: Date.now() - startedAt,
        error,
      });
      return {
        ok: false,
        error: "Translation failed.",
        code: "provider_error",
        progressAdvanced: false,
        status: 500,
      };
    }
  });
}

function keepAliveJsonResponse(work: () => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode("\n"));
      }, 10_000);

      try {
        const payload = await work();
        controller.enqueue(encoder.encode(JSON.stringify(payload)));
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        controller.close();
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
