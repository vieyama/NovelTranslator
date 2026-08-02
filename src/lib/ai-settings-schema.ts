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

/** Model names are sent to the provider API, so keep them to a sane shape. */
export function validateModelName(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === "") return null;
  if (trimmed.length > 100) return null;
  if (!/^[a-zA-Z0-9._@:-]+$/.test(trimmed)) return null;

  return trimmed;
}
