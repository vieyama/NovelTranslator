// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Pulls in both API clients.
import "server-only";

import { createClaudeProvider } from "./claudeClient";
import { createGeminiProvider } from "./geminiClient";
import { TranslationError, type TranslationProvider } from "./types";

/**
 * Chooses the translation provider from config (SPEC.md §6).
 *
 * This is the only place that knows which providers exist. Everything
 * downstream — batching, `parseResponse`, the watermark rules — is identical
 * regardless of which one is returned.
 */

export type ProviderName = "claude" | "gemini";

const DEFAULT_PROVIDER: ProviderName = "claude";

/** `anthropic` is accepted because that's the name SPEC.md §7 used. */
const ALIASES: Record<string, ProviderName> = {
  claude: "claude",
  anthropic: "claude",
  gemini: "gemini",
  google: "gemini",
};

const FACTORIES: Record<ProviderName, () => TranslationProvider> = {
  claude: createClaudeProvider,
  gemini: createGeminiProvider,
};

/**
 * @param requested Overrides `TRANSLATION_PROVIDER`; used by tests and by any
 *   future per-book provider setting.
 */
export function resolveProvider(requested?: string): TranslationProvider {
  const raw = (requested ?? process.env.TRANSLATION_PROVIDER ?? DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();

  const name = ALIASES[raw];

  if (!name) {
    throw new TranslationError(
      `Unknown TRANSLATION_PROVIDER "${raw}". Use "claude" or "gemini".`,
      "provider_error",
      500,
    );
  }

  return FACTORIES[name]();
}
