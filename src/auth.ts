// Server-only: reads the user table and the password hash.
import "server-only";

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/password";

/**
 * NextAuth v5 (Auth.js) with email + password (SPEC.md §8).
 *
 * `strategy: "jwt"` is not a preference — the Credentials provider only works
 * with JWT sessions, since there is no OAuth callback for NextAuth to hang a
 * database session off. The session therefore lives entirely in a signed
 * cookie, which is why the user id is copied into the token below: every
 * request needs it to scope queries, and re-reading the user row on each one
 * would be a query per request for a value that never changes.
 *
 * There is deliberately no public sign-up (SPEC.md §8): accounts come from
 * `bun run user:create`. This instance is internet-facing, and an open
 * registration form on it would let anyone create an account.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";

        if (email.trim() === "" || password === "") return null;

        const user = await prisma.user.findUnique({
          where: { email: email.trim().toLowerCase() },
          select: { id: true, email: true, name: true, passwordHash: true },
        });

        // Verify even when the user doesn't exist, against a hash that cannot
        // match. Returning early instead would make "no such account" measurably
        // faster than "wrong password" and turn login timing into a way to
        // enumerate registered emails.
        const hash = user?.passwordHash ?? DUMMY_HASH;
        const ok = await verifyPassword(password, hash);

        if (!user || !ok) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      // `user` is only present on the sign-in pass; afterwards the id rides
      // along in the token.
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});

/**
 * A structurally valid scrypt hash of a value nobody can supply, used purely so
 * the "no such user" path does the same work as the real one. Generated once
 * with the same parameters `hashPassword` uses.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "GkFhV1hBTUJrZHVtbXlwYWRkaW5nZm9ydGltaW5nZXF1YWxpdHlkdW1teWhhc2h2YWx1ZXh4eHh4eHh4eHh4eHh4eHg=";
