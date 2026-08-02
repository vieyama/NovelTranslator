// Server-only: this module reads the master encryption key. Importing it from
// a Client Component would put that key in the browser bundle.
import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption for user-supplied API keys (SPEC.md §8).
 *
 * Three layers, and the ordering of trust matters:
 *
 *   APP_ENCRYPTION_KEY (env, never in the DB)
 *     └─ wraps ─> User.encryptedDek        (AAD = user id)
 *                   └─ decrypts to ─> DEK  (per user, only ever in memory)
 *                                       └─ encrypts ─> the provider API key
 *
 * The point of the master key living outside the database is that a stolen
 * database dump is not enough to read anyone's API key. A scheme that derives
 * the key from a username (or any other column) fails exactly here: every
 * ingredient needed to unwrap it is sitting in the same dump. That is why the
 * user id is used as *associated data* rather than as key material — see below.
 *
 * `aad` (additional authenticated data) is authenticated but not encrypted:
 * GCM will refuse to decrypt if it doesn't match what was used to encrypt.
 * Passing the user id binds each ciphertext to its owner, so moving a wrapped
 * DEK or an encrypted key from one user's row to another turns it into an
 * authentication failure instead of a working credential.
 *
 * Ciphertexts are stored as `v1.<iv>.<tag>.<ciphertext>`, all base64url. The
 * version prefix is what makes key rotation possible later without guessing at
 * the format of existing rows.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96 bits is the size GCM is specified for; other sizes weaken it. */
const IV_BYTES = 12;
const VERSION = "v1";

/** Anything unreadable is thrown as this, never as a raw crypto error. */
export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCryptoError";
  }
}

/**
 * The root key, from `APP_ENCRYPTION_KEY` (32 bytes, base64).
 *
 * Read on every call rather than cached at module load so a missing key
 * surfaces at the point of use with a message that says how to fix it, instead
 * of crashing the whole server on import.
 *
 * Generate one with:  openssl rand -base64 32
 */
function getMasterKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY?.trim();

  if (!raw) {
    throw new SecretCryptoError(
      "APP_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` " +
        "and add it to .env and .env.local.",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new SecretCryptoError("APP_ENCRYPTION_KEY is not valid base64.");
  }

  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `APP_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }

  return key;
}

/** True when a usable master key is configured — for surfacing setup problems in the UI. */
export function hasMasterKey(): boolean {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

function encrypt(plaintext: Buffer, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decrypt(blob: string, key: Buffer, aad: string): Buffer {
  const parts = blob.split(".");

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretCryptoError("Stored ciphertext is malformed or of an unknown version.");
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]);
  } catch {
    // Wrong master key, tampered row, or a ciphertext lifted from another
    // user — GCM cannot tell us which, and neither should the error message.
    throw new SecretCryptoError(
      "Could not decrypt. The APP_ENCRYPTION_KEY may have changed, or the stored " +
        "value belongs to a different user.",
    );
  }
}

/** A fresh per-user data key. Generated once, at user creation. */
export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Wraps a DEK with the master key for storage in `User.encryptedDek`. */
export function wrapDek(dek: Buffer, userId: string): string {
  if (dek.length !== KEY_BYTES) {
    throw new SecretCryptoError(`A DEK must be ${KEY_BYTES} bytes, got ${dek.length}.`);
  }
  return encrypt(dek, getMasterKey(), userId);
}

/** Inverse of `wrapDek`. The result must never leave the server. */
export function unwrapDek(encryptedDek: string, userId: string): Buffer {
  const dek = decrypt(encryptedDek, getMasterKey(), userId);

  if (dek.length !== KEY_BYTES) {
    throw new SecretCryptoError("Unwrapped DEK has the wrong length.");
  }

  return dek;
}

/**
 * Encrypts a provider API key under the user's DEK.
 *
 * `aad` combines the user and the provider, so a Claude key can't be replayed
 * into the Gemini slot (or another user's row) and still decrypt.
 */
export function encryptSecret(plaintext: string, dek: Buffer, aad: string): string {
  return encrypt(Buffer.from(plaintext, "utf8"), dek, aad);
}

export function decryptSecret(blob: string, dek: Buffer, aad: string): string {
  return decrypt(blob, dek, aad).toString("utf8");
}

/**
 * Constant-time equality for secrets.
 *
 * `timingSafeEqual` throws on length mismatch — and the lengths themselves are
 * compared in variable time — so differing lengths are reported as "not equal"
 * rather than leaking through an exception.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  if (bufferA.length !== bufferB.length) return false;

  return timingSafeEqual(bufferA, bufferB);
}

/**
 * A non-reversible hint for the settings UI: enough to recognise which key is
 * stored, not enough to reconstruct it. The full key is never sent to the
 * browser after it has been saved.
 */
export function maskSecret(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
