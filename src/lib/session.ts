// Server-only: wraps the auth session and the user row behind it.
import "server-only";

import { redirect } from "next/navigation";

import { auth } from "@/auth";

/**
 * The single place a request turns into "which user is this".
 *
 * Every query that touches user-owned data goes through one of these, so
 * scoping can't be forgotten in one route and silently expose another user's
 * library. `proxy.ts` also redirects unauthenticated traffic, but that is a
 * convenience for the browser, not the enforcement point — it only inspects
 * whether a session cookie exists. These functions are where the cookie is
 * actually verified.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/** The signed-in user, or null. For places where anonymous is a valid state. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();

  if (!session?.user?.id) return null;

  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? null,
  };
}

/**
 * The signed-in user, or a redirect to the login page. For Server Components.
 *
 * `next` carries where they were headed so login can send them back rather
 * than dumping everyone on the library.
 */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getSessionUser();

  if (!user) {
    redirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login");
  }

  return user;
}

/** Thrown by `requireApiUser`; the route handlers turn it into a 401. */
export class UnauthorizedError extends Error {
  readonly status = 401;

  constructor() {
    super("Not signed in.");
    this.name = "UnauthorizedError";
  }
}

/**
 * The signed-in user for a route handler.
 *
 * Throws rather than redirecting: an API caller needs a 401 it can act on, not
 * a 302 to an HTML login page that `fetch` would follow and then fail to parse.
 */
export async function requireApiUser(): Promise<SessionUser> {
  const user = await getSessionUser();

  if (!user) throw new UnauthorizedError();

  return user;
}
