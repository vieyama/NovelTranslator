// Server-only: decrypts API keys and touches Prisma.
import "server-only";

import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER,
  parseAiProvider,
  validateModelName,
  type AiProviderName,
  type AiSettingsView,
} from "@/lib/ai-settings-schema";
import {
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  hasMasterKey,
  maskSecret,
  unwrapDek,
} from "@/lib/crypto";
import { prisma } from "@/lib/db";

/**
 * Per-user AI provider settings (SPEC.md §8).
 *
 * Resolution order for every value is: **user setting → server env var →
 * built-in default**. That keeps a fresh install working exactly as it did
 * before settings existed, and lets a user who hasn't configured anything ride
 * on the server's keys.
 */

export class AiSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AiSettingsError";
  }
}

/** Binds a ciphertext to one user *and* one provider — see crypto.ts on AAD. */
function credentialAad(userId: string, provider: AiProviderName): string {
  return `${userId}:${provider}`;
}

/** The env var each provider falls back to when the user hasn't stored a key. */
const ENV_KEY_BY_PROVIDER: Record<AiProviderName, string> = {
  claude: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

function envKeyFor(provider: AiProviderName): string | null {
  return process.env[ENV_KEY_BY_PROVIDER[provider]]?.trim() || null;
}

/** Everything the settings page needs — never the plaintext key. */
export async function getAiSettingsView(userId: string): Promise<AiSettingsView> {
  const [user, credentials] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { aiProvider: true } }),
    prisma.aiProviderCredential.findMany({
      where: { userId },
      select: { provider: true, model: true, encryptedApiKey: true },
    }),
  ]);

  const byProvider = new Map(credentials.map((c) => [c.provider, c]));
  const encryptionReady = hasMasterKey();

  // Unwrapped once for this call if anything needs masking, then dropped when
  // the function returns. Never held in a module-level cache: that would keep
  // one user's data key alive across requests for every other user's requests
  // too, which is exactly what the per-user DEK design exists to avoid.
  const needsDek = encryptionReady && credentials.some((c) => c.encryptedApiKey);
  const dek = needsDek ? await loadDekQuietly(userId) : null;

  return {
    activeProvider: parseAiProvider(user?.aiProvider),
    encryptionReady,
    providers: AI_PROVIDERS.map((meta) => {
      const stored = byProvider.get(meta.value);
      const hasApiKey = Boolean(stored?.encryptedApiKey);

      return {
        provider: meta.value,
        model: stored?.model ?? null,
        hasApiKey,
        // The mask is derived from the real key so it actually identifies
        // which one is stored. If it can't be decrypted (master key changed),
        // show no mask rather than failing the whole page — the user's fix is
        // to re-enter the key, and they need the page to render to do that.
        maskedApiKey:
          hasApiKey && dek
            ? tryMask(stored!.encryptedApiKey!, dek, credentialAad(userId, meta.value))
            : null,
        hasEnvFallback: envKeyFor(meta.value) !== null,
      };
    }),
  };
}

function tryMask(encryptedApiKey: string, dek: Buffer, aad: string): string | null {
  try {
    return maskSecret(decryptSecret(encryptedApiKey, dek, aad));
  } catch {
    return null;
  }
}

/** Loads and unwraps this user's DEK, or null if it can't be read. */
async function loadDekQuietly(userId: string): Promise<Buffer | null> {
  try {
    return await loadDek(userId);
  } catch {
    return null;
  }
}

/**
 * Loads and unwraps this user's DEK.
 *
 * The plaintext key exists only for the lifetime of the caller's work — there
 * is no cache by design (see above).
 */
async function loadDek(userId: string): Promise<Buffer> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { encryptedDek: true },
  });

  if (!user) throw new AiSettingsError("User not found.", 404);

  return unwrapDek(user.encryptedDek, userId);
}

export interface SaveAiSettingsInput {
  provider: unknown;
  model?: unknown;
  /** Undefined = leave the stored key alone. "" = clear it. */
  apiKey?: unknown;
}

/** Writes the settings form back. Returns the refreshed view. */
export async function saveAiSettings(
  userId: string,
  input: SaveAiSettingsInput,
): Promise<AiSettingsView> {
  const provider = parseAiProvider(input.provider);

  let model: string | null = null;
  if (typeof input.model === "string" && input.model.trim() !== "") {
    model = validateModelName(input.model);
    if (model === null) {
      throw new AiSettingsError(
        "Nama model hanya boleh berisi huruf, angka, titik, titik dua, garis, dan @.",
        400,
      );
    }
  }

  const apiKeyGiven = typeof input.apiKey === "string";
  const apiKey = apiKeyGiven ? (input.apiKey as string).trim() : undefined;

  let encryptedApiKey: string | null | undefined;

  if (apiKey !== undefined) {
    if (apiKey === "") {
      // Explicitly cleared — fall back to the env var from here on.
      encryptedApiKey = null;
    } else {
      if (!hasMasterKey()) {
        throw new AiSettingsError(
          "APP_ENCRYPTION_KEY belum diset di server, jadi API key tidak bisa disimpan dengan aman.",
          500,
        );
      }

      const dek = await loadDek(userId);
      encryptedApiKey = encryptSecret(apiKey, dek, credentialAad(userId, provider));
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { aiProvider: provider } });

    await tx.aiProviderCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        model,
        encryptedApiKey: encryptedApiKey ?? null,
      },
      update: {
        model,
        // `undefined` tells Prisma to leave the column untouched, which is how
        // "save the model without re-entering my API key" works.
        ...(encryptedApiKey === undefined ? {} : { encryptedApiKey }),
      },
    });
  });

  return getAiSettingsView(userId);
}

export interface ResolvedAiConfig {
  provider: AiProviderName;
  model: string | null;
  apiKey: string;
  /** Where the key came from — surfaced in errors so setup problems are obvious. */
  source: "user" | "env";
}

/**
 * The provider, model, and API key a translation request should actually use.
 *
 * This is the only path from the database to a decrypted API key. It throws a
 * message aimed at the person who can fix it, because "missing API key" is by
 * far the most likely failure once keys move out of env vars.
 */
export async function resolveAiConfig(userId: string): Promise<ResolvedAiConfig> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiProvider: true },
  });

  const provider = parseAiProvider(user?.aiProvider ?? DEFAULT_AI_PROVIDER);

  const credential = await prisma.aiProviderCredential.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { model: true, encryptedApiKey: true },
  });

  let apiKey: string | null = null;
  let source: "user" | "env" = "env";

  if (credential?.encryptedApiKey) {
    try {
      const dek = await loadDek(userId);
      apiKey = decryptSecret(credential.encryptedApiKey, dek, credentialAad(userId, provider));
      source = "user";
    } catch (error) {
      if (error instanceof SecretCryptoError) {
        throw new AiSettingsError(
          "API key tersimpan tidak bisa didekripsi. APP_ENCRYPTION_KEY mungkin berubah — " +
            "masukkan ulang API key di halaman Pengaturan.",
          500,
        );
      }
      throw error;
    }
  }

  if (!apiKey) {
    apiKey = envKeyFor(provider);
    source = "env";
  }

  if (!apiKey) {
    throw new AiSettingsError(
      `Belum ada API key untuk ${provider}. Tambahkan di halaman Pengaturan.`,
      400,
    );
  }

  return { provider, model: credential?.model ?? null, apiKey, source };
}
