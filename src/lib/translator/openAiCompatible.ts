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
 * Shared client for providers that speak the OpenAI chat-completions shape
 * (SPEC.md §6) — currently Mistral and OpenRouter.
 *
 * Both are one POST with `{ model, messages }` in and
 * `choices[0].message.content` out, differing only in URL, default model, and a
 * couple of headers. Two copies of this file would drift: a fix to the
 * finish-reason handling or the defensive content parsing would land in one and
 * not the other. Claude and Gemini keep their own clients because their SDKs
 * and response shapes are genuinely different (streaming, thinking blocks,
 * typed enums).
 *
 * **Plain `fetch`, no SDK.** The vendor SDKs wrap this same POST in `ws`, `zod`
 * and OpenTelemetry dependencies; every one of those is another thing that can
 * break a Bun build (§7.1).
 */

export interface OpenAiCompatibleSpec {
  /** Provider id, matching `AI_PROVIDERS` — e.g. "mistral". */
  id: string;
  /** Human name, used in error messages the user will read. */
  label: string;
  apiUrl: string;
  defaultModel: string;
  /** Server-wide model override, e.g. "MISTRAL_MODEL". */
  modelEnvVar: string;
  /**
   * Translation should be faithful, not inventive — and the reply has to come
   * back with exactly the separator count it was sent, which a high
   * temperature puts at risk.
   */
  temperature: number;
  /** Extra headers, evaluated per request (OpenRouter's attribution pair). */
  extraHeaders?: () => Record<string, string>;
}

/** Matches the other clients' ceiling; a truncated reply fails the batch. */
const MAX_TOKENS = 32_000;
const DEFAULT_TIMEOUT_MS = 240_000;

/** No module-level client cache — see the note in claudeClient.ts (per-user keys). */

export function createOpenAiCompatibleProvider(
  spec: OpenAiCompatibleSpec,
  config: ProviderConfig,
): TranslationProvider {
  return {
    id: spec.id,
    translateBatch: (request) => translateBatch(request, config, spec),
  };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: {
    message?: { content?: unknown };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** OpenRouter reports upstream failures in the 200 body rather than an HTTP status. */
  error?: { message?: unknown; code?: unknown };
}

async function translateBatch(
  request: TranslationRequest,
  config: ProviderConfig,
  spec: OpenAiCompatibleSpec,
): Promise<TranslationResponse> {
  const apiKey = config.apiKey.trim();

  if (!apiKey) {
    throw new TranslationError(
      `Belum ada API key ${spec.label}. Tambahkan di halaman Pengaturan.`,
      "missing_api_key",
      400,
    );
  }

  const model = config.model?.trim() || process.env[spec.modelEnvVar]?.trim() || spec.defaultModel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveTimeoutMs(spec.id));

  let response: Response;

  try {
    response = await fetch(spec.apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(spec.extraHeaders?.() ?? {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: spec.temperature,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
  } catch (error) {
    if (
      (error instanceof Error && error.name === "AbortError") ||
      /abort|timeout|timed out/i.test(error instanceof Error ? error.message : String(error))
    ) {
      throw new TranslationError(
        `${spec.label} took too long to answer. Retry with a smaller batch, or lower ${spec.id.toUpperCase()}_MAX_CHARS.`,
        "provider_error",
        504,
      );
    }

    throw new TranslationError(
      `Tidak bisa menghubungi ${spec.label}: ${error instanceof Error ? error.message : String(error)}`,
      "provider_error",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw await toHttpError(response, spec);
  }

  let payload: ChatCompletionResponse;

  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new TranslationError(`${spec.label} returned a non-JSON body.`, "provider_error");
  }

  // OpenRouter proxies other vendors, and an upstream failure comes back as
  // HTTP 200 with an `error` object instead of `choices`. Without this the next
  // line would report the far less useful "returned no choices".
  if (payload.error) {
    const message =
      typeof payload.error.message === "string" ? payload.error.message : "unknown error";
    throw new TranslationError(`${spec.label} error: ${message}`, "provider_error");
  }

  const choice = payload.choices?.[0];

  if (!choice) {
    throw new TranslationError(`${spec.label} returned no choices.`, "empty_response");
  }

  assertUsableFinishReason(choice.finish_reason, spec);

  const text = extractText(choice.message?.content);

  if (text.trim().length === 0) {
    throw new TranslationError(
      `${spec.label} returned no text content for this batch.`,
      "empty_response",
    );
  }

  return {
    text,
    // The API echoes the resolved model, so an alias is reported as the
    // concrete version it mapped to.
    model: payload.model ?? model,
    usage: {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    },
  };
}

function resolveTimeoutMs(providerId: string): number {
  const providerEnvVar = `${providerId.toUpperCase()}_TIMEOUT_MS`;
  const configured = Number.parseInt(
    process.env[providerEnvVar] ?? process.env.TRANSLATION_TIMEOUT_MS ?? "",
    10,
  );

  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
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
 * put — same contract as the other clients.
 */
function assertUsableFinishReason(
  reason: string | undefined,
  spec: OpenAiCompatibleSpec,
): void {
  if (reason === undefined || reason === "stop") return;

  // `model_length` is Mistral's "ran out of context", `length` the max_tokens cap.
  if (reason === "length" || reason === "model_length") {
    throw new TranslationError(
      `Balasan ${spec.label} terpotong karena batas token. Coba lagi dengan maxChars lebih kecil.`,
      "truncated",
    );
  }

  if (reason === "content_filter") {
    throw new TranslationError(
      `${spec.label} menolak menerjemahkan batch ini. Lewati atau sunting paragrafnya, lalu coba lagi.`,
      "refusal",
    );
  }

  throw new TranslationError(
    `${spec.label} berhenti dengan alasan tak terduga (${reason}).`,
    "provider_error",
  );
}

async function toHttpError(
  response: Response,
  spec: OpenAiCompatibleSpec,
): Promise<TranslationError> {
  const detail = await readErrorMessage(response);

  if (response.status === 401 || response.status === 403) {
    return new TranslationError(
      `API key ${spec.label} ditolak: ${detail}`,
      "missing_api_key",
      // 400, not 500: the fix is the user's key in Settings, not the server.
      400,
    );
  }

  if (response.status === 402) {
    // OpenRouter's "out of credit".
    return new TranslationError(
      `Kredit ${spec.label} habis. Isi ulang atau pilih model gratis. (${detail})`,
      "provider_error",
      402,
    );
  }

  if (response.status === 429) {
    return new TranslationError(
      `Kuota atau rate limit ${spec.label} tercapai. Tunggu lalu coba lagi. (${detail})`,
      "provider_error",
      429,
    );
  }

  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return new TranslationError(
      `${spec.label} menolak permintaan ini — biasanya nama model salah. (${detail})`,
      "provider_error",
      400,
    );
  }

  return new TranslationError(
    `${spec.label} API error ${response.status}: ${detail}`,
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
