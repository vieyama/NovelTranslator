// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Holds GEMINI_API_KEY.
import "server-only";

import { FinishReason, GoogleGenAI, type GenerateContentResponse } from "@google/genai";

import {
  TranslationError,
  type ProviderConfig,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResponse,
} from "./types";

/**
 * Google Gemini implementation of `TranslationProvider` (SPEC.md §6).
 *
 * Deliberately the same shape as `claudeClient.ts` — `{ system, user } →
 * { text, model, usage }` — so batching, `parseResponse`, and the watermark
 * rules in `translateNextBatch.ts` work identically whichever provider is
 * selected. The prompt itself is built once in `prompt.ts` and shared; nothing
 * about TRANSLATION_RULES.md or the glossary is duplicated here.
 */

/**
 * Alias tracking Google's current Flash model, so this default doesn't rot when
 * a new version ships.
 *
 * Flash rather than Pro because `gemini-pro-latest` has a free-tier quota of
 * zero — the whole point of a second provider here is having something to fall
 * back to when a free tier runs out. Set GEMINI_MODEL=gemini-pro-latest if the
 * key is on a paid plan.
 */
const DEFAULT_MODEL = "gemini-flash-latest";

/** Matches the Claude client's ceiling; a truncated reply fails the batch. */
const MAX_OUTPUT_TOKENS = 32_000;
const DEFAULT_TIMEOUT_MS = 85_000;

/** No module-level cache — see the note in claudeClient.ts (per-user keys). */

export function createGeminiProvider(config: ProviderConfig): TranslationProvider {
  return {
    id: "gemini",
    translateBatch: (request) => translateBatch(request, config),
  };
}

async function translateBatch(
  request: TranslationRequest,
  config: ProviderConfig,
): Promise<TranslationResponse> {
  const client = getClient(config.apiKey);
  const model = config.model?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const timeoutMs = resolveTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: GenerateContentResponse;

  try {
    response = await client.models.generateContent({
      model,
      contents: request.user,
      config: {
        // Gemini's equivalent of a system prompt — same rendered text the
        // Claude client sends as `system`.
        systemInstruction: request.system,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: controller.signal,
      },
    });
  } catch (error) {
    throw toTranslationError(error);
  } finally {
    clearTimeout(timeout);
  }

  assertUsableResponse(response);

  const text = extractText(response);

  if (text.trim().length === 0) {
    throw new TranslationError(
      "Gemini returned no text content for this batch.",
      "empty_response",
    );
  }

  return {
    text,
    model,
    usage: {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

function getClient(apiKey: string): GoogleGenAI {
  if (!apiKey.trim()) {
    throw new TranslationError(
      "Belum ada API key Gemini. Tambahkan di halaman Pengaturan, atau set GEMINI_API_KEY di server.",
      "missing_api_key",
      400,
    );
  }

  return new GoogleGenAI({ apiKey });
}

/**
 * Anything other than a clean stop must fail the batch so the watermark stays
 * put — same contract as the Claude client.
 */
function assertUsableResponse(response: GenerateContentResponse): void {
  // A blocked *prompt* has no candidates at all.
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new TranslationError(
      `Gemini blocked this batch (${blockReason}). Skip or edit these paragraphs and try again.`,
      "refusal",
    );
  }

  const candidate = response.candidates?.[0];

  if (!candidate) {
    throw new TranslationError("Gemini returned no candidates.", "empty_response");
  }

  if (candidate.finishReason === FinishReason.MAX_TOKENS) {
    throw new TranslationError(
      "Gemini's reply hit the output limit and was cut off. Retry with a smaller maxChars.",
      "truncated",
    );
  }

  const refusalReasons: FinishReason[] = [
    FinishReason.SAFETY,
    FinishReason.RECITATION,
    FinishReason.PROHIBITED_CONTENT,
    FinishReason.BLOCKLIST,
    FinishReason.SPII,
    FinishReason.IMAGE_SAFETY,
  ];

  if (candidate.finishReason && refusalReasons.includes(candidate.finishReason)) {
    throw new TranslationError(
      `Gemini declined to translate this batch (${candidate.finishReason}). Skip or edit these paragraphs and try again.`,
      "refusal",
    );
  }
}

/**
 * Concatenates the reply's text parts, skipping "thought" parts so internal
 * reasoning can never be mistaken for a translated paragraph.
 */
function extractText(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];

  return parts
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function toTranslationError(error: unknown): TranslationError {
  if (error instanceof TranslationError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (
    (error instanceof Error && error.name === "AbortError") ||
    /abort|timeout|timed out/i.test(message)
  ) {
    return new TranslationError(
      "Gemini took too long to answer. Retry with a smaller batch, or lower GEMINI_MAX_CHARS.",
      "provider_error",
      504,
    );
  }

  // The SDK surfaces HTTP failures as errors carrying the status in the text.
  if (/\b401\b|\b403\b|API key/i.test(message)) {
    return new TranslationError(
      `GEMINI_API_KEY was rejected: ${message}`,
      "missing_api_key",
      500,
    );
  }

  if (/\b429\b|quota|rate limit/i.test(message)) {
    return new TranslationError(
      `Gemini rate limit or quota hit. Wait and retry. (${message})`,
      "provider_error",
      429,
    );
  }

  return new TranslationError(`Gemini API error: ${message}`, "provider_error");
}

function resolveTimeoutMs(): number {
  const configured = Number.parseInt(process.env.GEMINI_TIMEOUT_MS ?? "", 10);

  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}
