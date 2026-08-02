// Server-only: password hashing has no business in a browser bundle.
import "server-only";

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing with scrypt.
 *
 * scrypt from `node:crypto` rather than bcrypt/argon2 from npm, deliberately:
 * both of those ship native bindings, and this project has already been burned
 * by one — Bun 1.3.x crashed fatally loading `better-sqlite3`'s binding, which
 * is part of why the driver is now pure-JS `pg` (SPEC.md §7.1). scrypt is
 * memory-hard, built into the runtime, and adds no dependency at all.
 *
 * Stored as `scrypt$N$r$p$<salt base64>$<hash base64>`; the parameters travel
 * with the hash so raising them later doesn't invalidate existing passwords —
 * old hashes keep verifying with the parameters they were made with.
 */

/**
 * `promisify` picks scrypt's shortest overload, losing the one that takes
 * options — so the cost parameters below would be silently ignored without
 * this annotation. Asserted rather than inferred for exactly that reason.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** ~100ms per hash on a modern machine; the cost is the point. */
const N = 16384;
const r = 8;
const p = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** scrypt needs maxmem above the default 32MB once N*r*p gets this large. */
const MAX_MEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password.normalize("NFKC"), salt, KEY_BYTES, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  }));

  return [
    "scrypt",
    N,
    r,
    p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing for any malformed stored value — a
 * corrupt row must read as "wrong password", never as a crash that
 * distinguishes one account from another.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, rawN, rawR, rawP, saltPart, hashPart] = parts;
  const parsedN = Number.parseInt(rawN, 10);
  const parsedR = Number.parseInt(rawR, 10);
  const parsedP = Number.parseInt(rawP, 10);

  if (!Number.isFinite(parsedN) || !Number.isFinite(parsedR) || !Number.isFinite(parsedP)) {
    return false;
  }

  const salt = Buffer.from(saltPart, "base64");
  const expected = Buffer.from(hashPart, "base64");
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = (await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: parsedN,
      r: parsedR,
      p: parsedP,
      maxmem: MAX_MEM,
    }));
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
