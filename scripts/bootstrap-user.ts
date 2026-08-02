/**
 * Creates the default account from environment variables, if it doesn't exist.
 *
 * Run by the `migrate` service on every deploy, right after
 * `prisma migrate deploy` (docker-compose.yml). That service is built from the
 * `builder` stage — the only image that still has `scripts/` and `tsx`; the
 * production `runner` image contains just `.next/standalone` and cannot run
 * this.
 *
 * Why it exists: without an account, every book from before authentication
 * stays unowned, and since all queries filter by owner the library renders
 * empty. That looks like data loss on the first deploy even though nothing was
 * lost. Creating the account here claims those books automatically.
 *
 * Behaviour, in order:
 *   - no BOOTSTRAP_USER_EMAIL/PASSWORD  -> skip quietly (local dev, or accounts
 *                                          managed by hand via user:create)
 *   - the email already exists          -> skip, and never touch the password
 *   - otherwise                         -> create it, claim orphaned books
 *
 * It deliberately does **not** reset the password of an existing account on
 * every deploy: that would silently undo a password change and turn a stale
 * Vault entry into a permanent backdoor.
 */
import "dotenv/config";

import { prisma } from "../src/lib/db";
import {
  UserCreateError,
  countOrphanBooks,
  createUser,
  emailExists,
  normalizeEmail,
} from "../src/lib/users";

async function main() {
  const email = process.env.BOOTSTRAP_USER_EMAIL?.trim();
  const password = process.env.BOOTSTRAP_USER_PASSWORD ?? "";
  const name = process.env.BOOTSTRAP_USER_NAME?.trim() || null;

  if (!email && !password) {
    console.log("[bootstrap] BOOTSTRAP_USER_* not set — skipping.");
    await reportOrphans();
    return;
  }

  // One without the other is a misconfiguration, not an intent to skip; saying
  // so beats silently starting with no way to log in.
  if (!email || !password) {
    console.error(
      "[bootstrap] Both BOOTSTRAP_USER_EMAIL and BOOTSTRAP_USER_PASSWORD are required. " +
        "No account was created.",
    );
    process.exitCode = 1;
    return;
  }

  const normalized = normalizeEmail(email);

  if (await emailExists(normalized)) {
    console.log(`[bootstrap] ${normalized} already exists — leaving it untouched.`);
    await reportOrphans();
    return;
  }

  const result = await createUser({ email: normalized, name, password });

  console.log(`[bootstrap] Created ${result.email}.`);

  if (result.claimedBooks > 0) {
    console.log(`[bootstrap] Adopted ${result.claimedBooks} pre-auth book(s) into this account.`);
  }

  await reportOrphans();
}

async function reportOrphans() {
  const orphans = await countOrphanBooks();

  if (orphans > 0) {
    console.warn(
      `[bootstrap] ${orphans} book(s) still have no owner and will not appear in any ` +
        `library. Only the first account claims them automatically.`,
    );
  }
}

main()
  .catch((error) => {
    // A failure here must be loud: the deploy continues (the app still starts),
    // but nobody can sign in, and the reason needs to be in the deploy log.
    console.error(
      "[bootstrap] Failed:",
      error instanceof UserCreateError || error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
