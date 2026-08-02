// Server-only: hashes passwords and wraps the per-user data key.
import "server-only";

import { generateDek, wrapDek } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";

/**
 * Account creation, shared by both entry points (SPEC.md §8.1).
 *
 * There is no public sign-up, so this is reachable two ways only:
 * `scripts/create-user.ts` (interactive) and `scripts/bootstrap-user.ts`
 * (env-driven, run by the `migrate` service on deploy). Both go through here so
 * the DEK wrapping and the book-claiming rule can't drift apart.
 */

export const MIN_PASSWORD_LENGTH = 10;

export class UserCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserCreateError";
  }
}

export interface CreateUserResult {
  id: string;
  email: string;
  /** Books adopted from the pre-auth era; only ever non-zero for the first account. */
  claimedBooks: number;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function assertValidEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UserCreateError(`"${email}" doesn't look like an email address.`);
  }
}

export function assertValidPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserCreateError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
}

export async function emailExists(email: string): Promise<boolean> {
  const found = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  return found !== null;
}

export async function createUser({
  email,
  name,
  password,
}: {
  email: string;
  name?: string | null;
  password: string;
}): Promise<CreateUserResult> {
  const normalized = normalizeEmail(email);

  assertValidEmail(normalized);
  assertValidPassword(password);

  if (await emailExists(normalized)) {
    throw new UserCreateError(`A user with the email ${normalized} already exists.`);
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    // Two steps because the DEK is bound to the user id as AAD, and the id
    // doesn't exist until the row does. One transaction, so a row can never be
    // left behind holding the placeholder.
    const created = await tx.user.create({
      data: { email: normalized, name: name?.trim() || null, passwordHash, encryptedDek: "" },
    });

    return tx.user.update({
      where: { id: created.id },
      data: { encryptedDek: wrapDek(generateDek(), created.id) },
    });
  });

  return {
    id: user.id,
    email: user.email,
    claimedBooks: await claimOrphanBooks(user.id),
  };
}

/**
 * Hands books uploaded before authentication existed to the first account.
 *
 * Those rows have `userId = NULL`, and every query filters by owner, so without
 * this they would be permanently invisible — which on the first deploy looks
 * exactly like data loss. Only the *first* account inherits them: a second user
 * must never be handed someone else's library.
 */
async function claimOrphanBooks(userId: string): Promise<number> {
  if ((await prisma.user.count()) !== 1) return 0;

  const { count } = await prisma.book.updateMany({
    where: { userId: null },
    data: { userId },
  });

  return count;
}

/** Unowned books still waiting for an owner — reported so they aren't forgotten. */
export async function countOrphanBooks(): Promise<number> {
  return prisma.book.count({ where: { userId: null } });
}
