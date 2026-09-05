// Server-only: importing this from a Client Component would pull secrets
// into the browser bundle. Handles API keys.
import "server-only";

import { createOpenAiCompatibleProvider } from "./openAiCompatible";
import type { ProviderConfig, TranslationProvider } from "./types";

/**
 * DeepSeek implementation of `TranslationProvider`.
 *
 * DeepSeek exposes an OpenAI-compatible chat-completions API at
 * https://api.deepseek.com, so the transport lives in `openAiCompatible.ts`.
 */
export function createDeepSeekProvider(config: ProviderConfig): TranslationProvider {
  return createOpenAiCompatibleProvider(
    {
      id: "deepseek",
      label: "DeepSeek",
      apiUrl: "https://api.deepseek.com/chat/completions",
      defaultModel: "deepseek-v4-flash",
      modelEnvVar: "DEEPSEEK_MODEL",
      // Keep separator-following stable.
      temperature: 0.2,
    },
    config,
  );
}
