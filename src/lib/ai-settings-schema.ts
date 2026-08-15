/**
 * AI provider/model options, shared by the settings page and the server.
 *
 * No Prisma import here — the settings form is a Client Component, and pulling
 * a Prisma-touching module into it would drag the `pg` driver into the browser
 * bundle (CLAUDE.md → Server / Client Module Boundary).
 */

export const AI_PROVIDERS = [
  {
    value: "claude",
    label: "Claude (Anthropic)",
    /** Where to get a key, shown next to the API key field. */
    keyHint: "console.anthropic.com",
    keyPlaceholder: "sk-ant-…",
    /** First entry is the provider client's built-in default. */
    models: [
      { value: "claude-opus-5", label: "Claude Opus 5 — paling kuat" },
      { value: "claude-sonnet-5", label: "Claude Sonnet 5 — seimbang" },
      { value: "claude-fable-5", label: "Claude Fable 5" },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — paling cepat" },
    ],
  },
  {
    value: "gemini",
    label: "Gemini (Google)",
    keyHint: "aistudio.google.com",
    keyPlaceholder: "AIza…",
    models: [
      { value: "gemini-flash-latest", label: "Gemini Flash (latest) — ada kuota gratis" },
      { value: "gemini-pro-latest", label: "Gemini Pro (latest) — tanpa kuota gratis" },
    ],
  },
  {
    value: "mistral",
    label: "Mistral",
    keyHint: "console.mistral.ai",
    keyPlaceholder: "…",
    // `-latest` aliases rather than dated names (`mistral-large-3-25-12`), so
    // these don't rot when a new version ships. Mistral releases models often;
    // the form's "Model lain (isi manual)" option covers anything newer than
    // this list without a code change.
    models: [
      { value: "mistral-large-latest", label: "Mistral Large (latest) — paling kuat" },
      { value: "mistral-medium-latest", label: "Mistral Medium (latest) — seimbang" },
      { value: "mistral-small-latest", label: "Mistral Small (latest) — paling murah" },
    ],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    keyHint: "openrouter.ai/keys",
    keyPlaceholder: "sk-or-v1-…",
    // A gateway to ~400 models across vendors, so this list is only a starting
    // point — "Model lain (isi manual)" is the real interface here. Ids carry a
    // vendor prefix and sometimes a `:free` suffix, which is why
    // `validateModelName` has to accept "/".
    //
    // Taken from OpenRouter's "Top models used by Free Models Router", with
    // every id and price checked against /api/v1/models rather than assumed:
    // **two of the five have no `:free` variant at all**, so appending the
    // suffix to the names shown on that page would produce ids that 404 at
    // translate time. They are listed at their real (paid, if cheap) prices
    // instead of being quietly dropped or mislabelled.
    //
    // Free ones first — that is the point of the list — and the largest of them
    // is the default, since translation quality is what this setting is for.
    models: [
      {
        value: "nvidia/nemotron-3-super-120b-a12b:free",
        label: "Nemotron 3 Super — gratis, konteks 262k",
      },
      {
        value: "nvidia/nemotron-3-nano-30b-a3b:free",
        label: "Nemotron 3 Nano 30B — gratis, konteks 256k",
      },
      { value: "openai/gpt-oss-20b:free", label: "gpt-oss-20b — gratis, konteks 131k" },
      { value: "openai/gpt-oss-120b", label: "gpt-oss-120b — berbayar (murah), konteks 131k" },
      { value: "tencent/hy3", label: "Tencent Hy3 — berbayar, konteks 262k" },
      {
        value: "openrouter/free",
        // Deliberately last and never the default: it picks a free model at
        // random per request, so consecutive batches of the same book can come
        // back in different styles — the opposite of what the glossary and
        // `translatedBy` exist to keep stable.
        label: "Free Models Router — acak tiap permintaan, gaya bisa berubah",
      },
    ],
  },
] as const;

export type AiProviderName = (typeof AI_PROVIDERS)[number]["value"];

export const DEFAULT_AI_PROVIDER: AiProviderName = "claude";

/** Sentinel for the "type a model name myself" option in the settings form. */
export const CUSTOM_MODEL = "__custom__";

const VALID_PROVIDERS = new Set<string>(AI_PROVIDERS.map((p) => p.value));

export function parseAiProvider(value: unknown): AiProviderName {
  return typeof value === "string" && VALID_PROVIDERS.has(value)
    ? (value as AiProviderName)
    : DEFAULT_AI_PROVIDER;
}

export function providerMeta(provider: AiProviderName) {
  return AI_PROVIDERS.find((p) => p.value === provider) ?? AI_PROVIDERS[0];
}

/** The model used when a user hasn't chosen one. Kept in sync with the clients' own defaults. */
export function defaultModelFor(provider: AiProviderName): string {
  return providerMeta(provider).models[0].value;
}

/**
 * What the settings page renders. The API key itself is never included — only
 * whether one is stored and a masked hint, so the page can be server-rendered
 * without the plaintext key ever reaching the browser.
 */
export interface AiProviderSettings {
  provider: AiProviderName;
  model: string | null;
  hasApiKey: boolean;
  maskedApiKey: string | null;
  /** True when no stored key exists but the server env var can stand in. */
  hasEnvFallback: boolean;
}

export interface AiSettingsView {
  activeProvider: AiProviderName;
  providers: AiProviderSettings[];
  /** False when APP_ENCRYPTION_KEY is missing — keys can't be saved at all. */
  encryptionReady: boolean;
}

/**
 * Model names are sent to the provider API, so keep them to a sane shape.
 *
 * `/` is allowed because OpenRouter namespaces every model by vendor
 * (`openai/gpt-4o`, `meta-llama/llama-3.3-70b-instruct:free`). Without it the
 * entire provider is unusable — every one of its ~400 model ids is rejected at
 * save time, with an error about punctuation rather than anything meaningful.
 *
 * Still a deny-by-default character set rather than a free-for-all: the value
 * is interpolated into a request body, and there is no reason for a model name
 * to contain whitespace, quotes, or control characters.
 */
export function validateModelName(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === "") return null;
  if (trimmed.length > 100) return null;
  if (!/^[a-zA-Z0-9._@:/-]+$/.test(trimmed)) return null;

  return trimmed;
}
