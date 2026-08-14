// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Handles API keys.
import "server-only";

import {
  TranslationError,
  type ProviderConfig,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResponse,
} from "./types";

/**
 * Mistral implementation of `TranslationProvider` (SPEC.md §6).
 *
 * Same shape as `claudeClient.ts` / `geminiClient.ts` — `{ system, user } →
 * { text, model, usage }` — so batching, `parseResponse`, and the watermark
 * rules in `translateNextBatch.ts` behave identically whichever provider is
 * selected. The prompt is built once in `prompt.ts` and shared; nothing about
 * TRANSLATION_RULES.md or the glossary is duplicated here.
 *
 * **Plain `fetch`, no SDK.** `@mistralai/mistralai` pulls in `ws`, `zod`,
 * `zod-to-json-schema` and an OpenTelemetry package to wrap what is a single
 * OpenAI-shaped POST. The other two providers need their SDKs (streaming,
 * thinking blocks, typed finish reasons); this one does not, and every
 * dependency here is one more thing that can break a Bun build.
 */

const API_URL = "https://api.mistral.ai/v1/chat/completions";

/**
 * Alias rather than a dated name (`mistral-large-3-25-12`), so the default
 * doesn't rot when a new version ships — same reasoning as
 * `gemini-flash-latest`. Mistral's own SDK examples use this string.
 */
const DEFAULT_MODEL = "mistral-large-latest";

/** Matches the other clients' ceiling; a truncated reply fails the batch. */
const MAX_TOKENS = 32_000;

/**
 * Translation should be faithful, not inventive. The other two providers are
 * left at their defaults, but Mistral's default temperature is high enough to
 * paraphrase, which matters when the reply has to come back with exactly the
 * same number of `---PARAGRAPH---` separators it was sent.
 */
const TEMPERATURE = 0.2;

/** No module-level cache — see the note in claudeClient.ts (per-user keys). */

export function createMistralProvider(config: ProviderConfig): TranslationProvider {
  return {
    id: "mistral",
    translateBatch: (request) => translateBatch(request, config),
  };
}

interface MistralResponse {
  model?: string;
  choices?: {
    message?: { content?: unknown };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function translateBatch(
  request: TranslationRequest,
  config: ProviderConfig,
): Promise<TranslationResponse> {
  const apiKey = config.apiKey.trim();

  if (!apiKey) {
    throw new TranslationError(
      "Belum ada API key Mistral. Tambahkan di halaman Pengaturan, atau set MISTRAL_API_KEY di server.",
      "missing_api_key",
      400,
    );
  }

  const model = config.model?.trim() || process.env.MISTRAL_MODEL?.trim() || DEFAULT_MODEL;

  let response: Response;

  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
  } catch (error) {
    // Network-level failure: no response at all.
    throw new TranslationError(
      `Tidak bisa menghubungi Mistral: ${error instanceof Error ? error.message : String(error)}`,
      "provider_error",
    );
  }

  if (!response.ok) {
    throw await toHttpError(response);
  }

  let payload: MistralResponse;

  try {
    payload = (await response.json()) as MistralResponse;
  } catch {
    throw new TranslationError("Mistral returned a non-JSON body.", "provider_error");
  }

  const choice = payload.choices?.[0];

  if (!choice) {
    throw new TranslationError("Mistral returned no choices.", "empty_response");
  }

  assertUsableFinishReason(choice.finish_reason);

  const text = extractText(choice.message?.content);

  if (text.trim().length === 0) {
    throw new TranslationError(
      "Mistral returned no text content for this batch.",
      "empty_response",
    );
  }

  return {
    text,
    // The API echoes the resolved model, so an alias like `mistral-large-latest`
    // is reported as the concrete version it mapped to.
    model: payload.model ?? model,
    usage: {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * `content` is normally a string, but the API also allows an array of typed
 * chunks. Read both, and ignore anything that isn't text so a non-text chunk
 * can never be mistaken for a translated paragraph — the same care
 * `geminiClient` takes with "thought" parts.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((chunk) => {
        if (typeof chunk === "string") return chunk;
        if (chunk && typeof chunk === "object" && "text" in chunk) {
          const { text } = chunk as { text?: unknown };
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

/**
 * Anything other than a clean stop must fail the batch so the watermark stays
 * put — same contract as the other two clients.
 */
function assertUsableFinishReason(reason: string | undefined): void {
  if (reason === undefined || reason === "stop") return;

  // `model_length` is Mistral's "ran out of context", `length` the max_tokens cap.
  if (reason === "length" || reason === "model_length") {
    throw new TranslationError(
      "Balasan Mistral terpotong karena batas token. Coba lagi dengan maxChars lebih kecil.",
      "truncated",
    );
  }

  if (reason === "content_filter") {
    throw new TranslationError(
      "Mistral menolak menerjemahkan batch ini. Lewati atau sunting paragrafnya, lalu coba lagi.",
      "refusal",
    );
  }

  throw new TranslationError(
    `Mistral berhenti dengan alasan tak terduga (${reason}).`,
    "provider_error",
  );
}

async function toHttpError(response: Response): Promise<TranslationError> {
  const detail = await readErrorMessage(response);

  if (response.status === 401 || response.status === 403) {
    return new TranslationError(
      `API key Mistral ditolak: ${detail}`,
      "missing_api_key",
      // 400, not 500: the fix is the user's key in Settings, not the server.
      400,
    );
  }

  if (response.status === 429) {
    return new TranslationError(
      `Kuota atau rate limit Mistral tercapai. Tunggu lalu coba lagi. (${detail})`,
      "provider_error",
      429,
    );
  }

  if (response.status === 422 || response.status === 400) {
    return new TranslationError(
      `Mistral menolak permintaan ini — biasanya nama model salah. (${detail})`,
      "provider_error",
      400,
    );
  }

  return new TranslationError(
    `Mistral API error ${response.status}: ${detail}`,
    "provider_error",
  );
}

/** Best-effort detail for the message; never lets a parse failure mask the real error. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.text();

    try {
      const parsed = JSON.parse(body) as { message?: unknown; error?: { message?: unknown } };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === "string" && message.trim() !== "") return message;
    } catch {
      // Not JSON — fall through to the raw body.
    }

    return body.slice(0, 300) || response.statusText;
  } catch {
    return response.statusText;
  }
}
