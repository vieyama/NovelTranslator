// Server-only: decrypts API keys and touches Prisma.
import "server-only";

import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER,
  parseAiProvider,
  validateModelName,
  type AiProviderName,
  type AiSettingsView,
  type SavedApiKey,
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
  const [user, credentials, keys] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { aiProvider: true } }),
    prisma.aiProviderCredential.findMany({
      where: { userId },
      select: { provider: true, model: true, activeKeyId: true },
    }),
    prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        provider: true,
        label: true,
        encryptedApiKey: true,
        createdAt: true,
        lastUsedAt: true,
      },
    }),
  ]);

  const settingsByProvider = new Map(credentials.map((c) => [c.provider, c]));
  const encryptionReady = hasMasterKey();

  // Unwrapped once for this call if anything needs masking, then dropped when
  // the function returns. Never held in a module-level cache: that would keep
  // one user's data key alive across requests for every other user's requests
  // too, which is exactly what the per-user DEK design exists to avoid.
  const dek = encryptionReady && keys.length > 0 ? await loadDekQuietly(userId) : null;

  return {
    activeProvider: parseAiProvider(user?.aiProvider),
    encryptionReady,
    providers: AI_PROVIDERS.map((meta) => {
      const settings = settingsByProvider.get(meta.value);
      const providerKeys: SavedApiKey[] = keys
        .filter((key) => key.provider === meta.value)
        .map((key) => ({
          id: key.id,
          label: key.label,
          // The mask is derived from the real key so it actually identifies
          // which one is stored. If it can't be decrypted (master key changed),
          // show no mask rather than failing the whole page — the user's fix is
          // to add the key again, and they need the page to render to do that.
          maskedApiKey: dek
            ? tryMask(key.encryptedApiKey, dek, credentialAad(userId, meta.value))
            : null,
          isActive: settings?.activeKeyId === key.id,
          createdAt: key.createdAt.toISOString(),
          lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        }));

      return {
        provider: meta.value,
        model: settings?.model ?? null,
        keys: providerKeys,
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
}

/** Writes the provider/model form back. Keys are managed separately below. */
export async function saveAiSettings(
  userId: string,
  input: SaveAiSettingsInput,
): Promise<AiSettingsView> {
  const provider = parseAiProvider(input.provider);
  const model = parseModel(input.model);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { aiProvider: provider } });

    await tx.aiProviderCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, model },
      update: { model },
    });
  });

  return getAiSettingsView(userId);
}

function parseModel(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;

  const model = validateModelName(value);

  if (model === null) {
    throw new AiSettingsError(
      "Nama model hanya boleh berisi huruf, angka, titik, titik dua, garis miring, dan @.",
      400,
    );
  }

  return model;
}

/** Labels only have to be readable in a list; keep them short and printable. */
function parseLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;

  const label = value.trim();

  if (label.length > 60) {
    throw new AiSettingsError("Nama kunci maksimal 60 karakter.", 400);
  }

  return label;
}

/**
 * Saves another key for a provider (SPEC.md §8.5).
 *
 * Becomes the active one when the provider had none — otherwise adding a key
 * would appear to do nothing. An existing active key is left alone, so adding a
 * spare doesn't silently switch what translations are running under.
 */
export async function addApiKey(
  userId: string,
  input: { provider: unknown; label?: unknown; apiKey: unknown },
): Promise<AiSettingsView> {
  const provider = parseAiProvider(input.provider);

  if (typeof input.apiKey !== "string" || input.apiKey.trim() === "") {
    throw new AiSettingsError("API key tidak boleh kosong.", 400);
  }

  if (!hasMasterKey()) {
    throw new AiSettingsError(
      "APP_ENCRYPTION_KEY belum diset di server, jadi API key tidak bisa disimpan dengan aman.",
      500,
    );
  }

  const existing = await prisma.apiKey.count({ where: { userId, provider } });
  const label = parseLabel(input.label, `Kunci ${existing + 1}`);

  const dek = await loadDek(userId);
  const encryptedApiKey = encryptSecret(
    input.apiKey.trim(),
    dek,
    credentialAad(userId, provider),
  );

  await prisma.$transaction(async (tx) => {
    const key = await tx.apiKey.create({
      data: { userId, provider, label, encryptedApiKey },
    });

    const credential = await tx.aiProviderCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, activeKeyId: key.id },
      update: {},
      select: { activeKeyId: true },
    });

    if (credential.activeKeyId === null) {
      await tx.aiProviderCredential.update({
        where: { userId_provider: { userId, provider } },
        data: { activeKeyId: key.id },
      });
    }
  });

  return getAiSettingsView(userId);
}

/** Switches which saved key translations run under — the whole point of §8.5. */
export async function activateApiKey(userId: string, keyId: unknown): Promise<AiSettingsView> {
  const key = await findOwnedKey(userId, keyId);

  await prisma.aiProviderCredential.upsert({
    where: { userId_provider: { userId, provider: key.provider } },
    create: { userId, provider: key.provider, activeKeyId: key.id },
    update: { activeKeyId: key.id },
  });

  return getAiSettingsView(userId);
}

/**
 * Deletes a saved key.
 *
 * `activeKeyId` is `SetNull` in the schema, so removing the key in use leaves
 * the provider with no active key rather than taking the model setting down
 * with it. Another key is promoted if one exists, since being left with saved
 * keys but none selected is a state with no purpose.
 */
export async function deleteApiKey(userId: string, keyId: unknown): Promise<AiSettingsView> {
  const key = await findOwnedKey(userId, keyId);

  await prisma.$transaction(async (tx) => {
    await tx.apiKey.delete({ where: { id: key.id } });

    const credential = await tx.aiProviderCredential.findUnique({
      where: { userId_provider: { userId, provider: key.provider } },
      select: { activeKeyId: true },
    });

    if (credential && credential.activeKeyId === null) {
      const replacement = await tx.apiKey.findFirst({
        where: { userId, provider: key.provider },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      if (replacement) {
        await tx.aiProviderCredential.update({
          where: { userId_provider: { userId, provider: key.provider } },
          data: { activeKeyId: replacement.id },
        });
      }
    }
  });

  return getAiSettingsView(userId);
}

/** Scopes every key operation to its owner — someone else's id is a 404. */
async function findOwnedKey(userId: string, keyId: unknown) {
  if (typeof keyId !== "string" || keyId.trim() === "") {
    throw new AiSettingsError("`keyId` wajib diisi.", 400);
  }

  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, userId },
    select: { id: true, provider: true },
  });

  if (!key) throw new AiSettingsError("API key tidak ditemukan.", 404);

  return key;
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
    select: { model: true, activeKey: { select: { id: true, encryptedApiKey: true } } },
  });

  let apiKey: string | null = null;
  let source: "user" | "env" = "env";

  if (credential?.activeKey) {
    try {
      const dek = await loadDek(userId);
      apiKey = decryptSecret(
        credential.activeKey.encryptedApiKey,
        dek,
        credentialAad(userId, provider),
      );
      source = "user";

      // Stamped on resolve rather than on success, so it reads as "last
      // attempted with". That is the more useful signal when hunting for the
      // key whose quota ran out — the failing one is exactly the one you want
      // to spot.
      await prisma.apiKey.update({
        where: { id: credential.activeKey.id },
        data: { lastUsedAt: new Date() },
      });
    } catch (error) {
      if (error instanceof SecretCryptoError) {
        throw new AiSettingsError(
          "API key tersimpan tidak bisa didekripsi. APP_ENCRYPTION_KEY mungkin berubah — " +
            "tambahkan ulang API key di halaman Pengaturan.",
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
