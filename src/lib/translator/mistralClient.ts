// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Handles API keys.
import "server-only";

import { createOpenAiCompatibleProvider } from "./openAiCompatible";
import type { ProviderConfig, TranslationProvider } from "./types";

/**
 * Mistral implementation of `TranslationProvider` (SPEC.md §6).
 *
 * Mistral speaks the OpenAI chat-completions shape, so everything real lives in
 * `openAiCompatible.ts` and this file is just the configuration.
 */
export function createMistralProvider(config: ProviderConfig): TranslationProvider {
  return createOpenAiCompatibleProvider(
    {
      id: "mistral",
      label: "Mistral",
      apiUrl: "https://api.mistral.ai/v1/chat/completions",
      /**
       * Alias rather than a dated name (`mistral-large-3-25-12`), so the
       * default doesn't rot when a new version ships — same reasoning as
       * `gemini-flash-latest`. Mistral's own SDK examples use this string.
       */
      defaultModel: "mistral-large-latest",
      modelEnvVar: "MISTRAL_MODEL",
      // Mistral's default is loose enough to paraphrase, which puts the
      // separator count at risk.
      temperature: 0.2,
    },
    config,
  );
}
