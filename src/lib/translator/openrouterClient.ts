// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Handles API keys.
import "server-only";

import { createOpenAiCompatibleProvider } from "./openAiCompatible";
import type { ProviderConfig, TranslationProvider } from "./types";

/**
 * OpenRouter implementation of `TranslationProvider` (SPEC.md §6).
 *
 * OpenRouter is a gateway in front of ~400 models from many vendors, speaking
 * the OpenAI chat-completions shape — so the transport lives in
 * `openAiCompatible.ts` and only the routing details are here.
 *
 * Its appeal is exactly the model catalogue, which is far too large and too
 * fast-moving to enumerate in `AI_PROVIDERS`. The short curated list there is a
 * starting point; the settings form's "Model lain (isi manual)" field is the
 * real interface, and model ids carry a vendor prefix (`openai/gpt-4o`) plus
 * sometimes a `:free` suffix.
 */
export function createOpenRouterProvider(config: ProviderConfig): TranslationProvider {
  return createOpenAiCompatibleProvider(
    {
      id: "openrouter",
      label: "OpenRouter",
      apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      defaultModel: "openai/gpt-4o",
      modelEnvVar: "OPENROUTER_MODEL",
      temperature: 0.2,
      extraHeaders: attributionHeaders,
    },
    config,
  );
}

/**
 * `HTTP-Referer` and `X-Title` are OpenRouter's optional attribution pair —
 * they identify the calling app on its public leaderboards.
 *
 * Both are omitted when empty rather than sent blank: an empty `HTTP-Referer`
 * is worse than none, and neither is required for the request to succeed.
 * `AUTH_URL` is reused as the site URL when a dedicated value isn't set, since
 * it already holds this instance's public origin (SPEC.md §8.1).
 */
function attributionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  const siteUrl = process.env.OPENROUTER_SITE_URL?.trim() || process.env.AUTH_URL?.trim();
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;

  const siteName = process.env.OPENROUTER_SITE_NAME?.trim() || "Novel Translator";
  headers["X-Title"] = siteName;

  return headers;
}
