/**
 * Provider-agnostic translation interface (SPEC.md §6).
 *
 * Only `claudeClient.ts` implements this for the MVP, but the translate route
 * depends on this interface rather than on Anthropic directly, so adding
 * `geminiClient.ts` later doesn't require touching the route.
 */

/** The exact marker the AI must emit between paragraphs (TRANSLATION_RULES.md). */
export const PARAGRAPH_SEPARATOR = "---PARAGRAPH---";

export interface TranslationRequest {
  /** Translator persona + rules + glossary, rendered from TRANSLATION_RULES.md. */
  system: string;
  /** The batch itself: the instruction line plus the separated source paragraphs. */
  user: string;
}

export interface TranslationResponse {
  /** Raw text the provider returned, still containing the separators. */
  text: string;
  /** Which model actually served the request (may differ from the one requested). */
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface TranslationProvider {
  /** Matches the `TRANSLATION_PROVIDER` value: `"claude"` or `"gemini"`. */
  readonly id: string;
  translateBatch(request: TranslationRequest): Promise<TranslationResponse>;
}

export type TranslationErrorCode =
  | "missing_api_key"
  | "provider_error"
  | "refusal"
  | "truncated"
  | "empty_response"
  | "count_mismatch";

/**
 * Any failure that must leave `lastTranslatedIndex` untouched
 * (CLAUDE.md → "Parsing the AI response").
 */
export class TranslationError extends Error {
  constructor(
    message: string,
    readonly code: TranslationErrorCode,
    readonly status = 502,
  ) {
    super(message);
    this.name = "TranslationError";
  }
}
