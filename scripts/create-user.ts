/**
 * Creates a user account. There is no public sign-up (SPEC.md §8), so this is
 * the only way in.
 *
 *   bun run user:create                      # prompts for everything
 *   bun run user:create you@example.com      # prompts for password only
 *
 * Must run under `tsx --conditions=react-server` (see package.json): the
 * modules it imports start with `import "server-only"`, which only compiles
 * away under that condition — without it Node throws "This module cannot be
 * imported from a Client Component module", which is misleading here since
 * nothing is a Client Component (CLAUDE.md).
 */
import "dotenv/config";

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";

import { prisma } from "../src/lib/db";
import {
  MIN_PASSWORD_LENGTH,
  UserCreateError,
  assertValidEmail,
  countOrphanBooks,
  createUser,
  emailExists,
  normalizeEmail,
} from "../src/lib/users";

async function main() {
  const email = normalizeEmail(process.argv[2] ?? (await ask("Email: ")));

  try {
    assertValidEmail(email);
  } catch (error) {
    fail(error instanceof UserCreateError ? error.message : String(error));
  }

  if (await emailExists(email)) {
    fail(`A user with the email ${email} already exists.`);
  }

  const name = (process.argv[3] ?? (await ask("Name (optional): "))).trim();

  const password = await askHidden("Password: ");
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if ((await askHidden("Confirm password: ")) !== password) {
    fail("Passwords don't match.");
  }

  const result = await createUser({ email, name, password });

  console.log(`\nCreated user ${result.email} (${result.id}).`);

  if (result.claimedBooks > 0) {
    console.log(`Assigned ${result.claimedBooks} pre-existing book(s) to this account.`);
  }

  const orphans = await countOrphanBooks();
  if (orphans > 0) {
    console.log(
      `\nNote: ${orphans} book(s) still have no owner. Only the first account ` +
        `claims them automatically; assign them deliberately if they belong here.`,
    );
  }

  console.log("\nSign in at /login.");
}

/**
 * Input handling, which has to cover two quite different cases.
 *
 * **Interactive (a real TTY)**: one long-lived readline interface, and a
 * writable that drops readline's echo while a password is being typed. One
 * interface for the whole run, not one per prompt — closing an interface ends
 * stdin, so a second prompt would never resolve.
 *
 * **Piped (`printf '…' | bun run user:create`)**: readline is bypassed
 * entirely. With non-TTY input its second `question()` never settles: the
 * stream has already ended, the promise stays pending, and the process exits
 * quietly having written nothing — no output, no error, exit code 0. So piped
 * input is read to the end once and handed out line by line instead. Keeping
 * this path working is what makes the script usable from a setup script.
 */
const isInteractive = stdin.isTTY === true;

let sharedRl: ReturnType<typeof createInterface> | null = null;
let muted = false;

let pipedLines: string[] | null = null;
let pipedIndex = 0;

function getReadline() {
  if (sharedRl) return sharedRl;

  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) stdout.write(chunk, encoding as BufferEncoding);
      callback();
    },
  });

  sharedRl = createInterface({ input: stdin, output, terminal: true });
  return sharedRl;
}

async function nextPipedLine(): Promise<string> {
  if (pipedLines === null) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    pipedLines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  }

  return pipedLines[pipedIndex++] ?? "";
}

async function ask(question: string): Promise<string> {
  stdout.write(question);

  if (!isInteractive) {
    const answer = await nextPipedLine();
    stdout.write("\n");
    return answer;
  }

  return getReadline().question("");
}

/**
 * Prompts without echoing.
 *
 * Passwords are read here rather than from argv so they don't land in shell
 * history or the process list, where any other user on the machine could read
 * them. Echo suppression only applies to a TTY — piped input was never on
 * screen to hide.
 */
async function askHidden(question: string): Promise<string> {
  stdout.write(question);

  if (!isInteractive) {
    const answer = await nextPipedLine();
    stdout.write("\n");
    return answer;
  }

  muted = true;
  try {
    return await getReadline().question("");
  } finally {
    muted = false;
    stdout.write("\n");
  }
}

function fail(message: string): never {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

main()
  .catch((error) => {
    console.error("\nFailed to create user:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    sharedRl?.close();
    await prisma.$disconnect();
  });
