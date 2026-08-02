// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Handles API keys.
import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import {
  TranslationError,
  type ProviderConfig,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResponse,
} from "./types";

/** Anthropic implementation of `TranslationProvider` (SPEC.md §6). */

const DEFAULT_MODEL = "claude-opus-5";

/**
 * Effort trades thinking depth against cost. `medium` is a deliberate default
 * for a repetitive, well-specified task on a personal-scale app — raise it via
 * TRANSLATION_EFFORT if translation quality needs more headroom.
 */
const DEFAULT_EFFORT = "medium";

/**
 * Generous because `max_tokens` caps thinking *and* output together on this
 * model, and a truncated reply fails the whole batch.
 */
const MAX_TOKENS = 32_000;

/**
 * If Anthropic's safety classifiers decline a batch (novels contain violence
 * and other dark themes), the API retries on a fallback model server-side
 * instead of handing back a refusal.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * No module-level client cache.
 *
 * There used to be one (`cachedClient ??= new Anthropic({ apiKey })`), which
 * was safe while the key came from a single env var. It is not safe now that
 * keys are per user (SPEC.md §8): the first request would pin one user's key
 * into the module and every later request — from any user — would translate
 * with it, billing the wrong account. Constructing a client per batch costs
 * nothing next to the API call itself.
 */

export function createClaudeProvider(config: ProviderConfig): TranslationProvider {
  return {
    // Matches the TRANSLATION_PROVIDER value, so the API response names the
    // provider the same way the config does.
    id: "claude",
    translateBatch: (request) => translateBatch(request, config),
  };
}

async function translateBatch(
  request: TranslationRequest,
  config: ProviderConfig,
): Promise<TranslationResponse> {
  const client = getClient(config.apiKey);
  // User setting first, then the server env var, then the built-in default.
  const model = config.model?.trim() || process.env.TRANSLATION_MODEL?.trim() || DEFAULT_MODEL;
  const effort = process.env.TRANSLATION_EFFORT?.trim() || DEFAULT_EFFORT;

  let message: Anthropic.Beta.Messages.BetaMessage;

  try {
    // Streamed so a long batch can't trip the SDK's HTTP timeout; the route
    // still waits for the complete message.
    const stream = client.beta.messages.stream({
      model,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: effort as Anthropic.Beta.Messages.BetaOutputConfig["effort"] },
      system: request.system,
      messages: [{ role: "user", content: request.user }],
    });

    message = await stream.finalMessage();
  } catch (error) {
    throw toTranslationError(error);
  }

  assertUsableStopReason(message);

  const text = message.content
    .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (text.trim().length === 0) {
    throw new TranslationError(
      "The model returned no text content for this batch.",
      "empty_response",
    );
  }

  return {
    text,
    model: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}

function getClient(apiKey: string): Anthropic {
  if (!apiKey.trim()) {
    throw new TranslationError(
      "Belum ada API key Claude. Tambahkan di halaman Pengaturan, atau set ANTHROPIC_API_KEY di server.",
      "missing_api_key",
      400,
    );
  }

  return new Anthropic({ apiKey });
}

/** Anything other than a clean finish means the batch must not be saved. */
function assertUsableStopReason(message: Anthropic.Beta.Messages.BetaMessage): void {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.type === "refusal" ? message.stop_details.category : null;

    throw new TranslationError(
      `The model declined to translate this batch${category ? ` (${category})` : ""}. Skip or edit these paragraphs and try again.`,
      "refusal",
    );
  }

  if (message.stop_reason === "max_tokens") {
    throw new TranslationError(
      "The reply hit the output limit and was cut off. Retry with a smaller maxChars.",
      "truncated",
    );
  }
}

function toTranslationError(error: unknown): TranslationError {
  if (error instanceof TranslationError) return error;

  if (error instanceof Anthropic.AuthenticationError) {
    return new TranslationError("ANTHROPIC_API_KEY was rejected.", "missing_api_key", 500);
  }

  if (error instanceof Anthropic.RateLimitError) {
    return new TranslationError("Anthropic rate limit hit. Wait and retry.", "provider_error", 429);
  }

  if (error instanceof Anthropic.APIError) {
    return new TranslationError(
      `Anthropic API error (${error.status}): ${error.message}`,
      "provider_error",
    );
  }

  return new TranslationError(
    error instanceof Error ? error.message : "Unknown translation failure.",
    "provider_error",
  );
}
