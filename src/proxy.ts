import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Redirects unauthenticated browsing to /login (SPEC.md §8).
 *
 * Named `proxy.ts`, not `middleware.ts`: Next 16 deprecated and renamed the
 * convention, and Proxy now defaults to the Node.js runtime (see
 * `node_modules/next/dist/docs/.../proxy.md`).
 *
 * **This is a redirect, not the security boundary.** It only checks whether a
 * session cookie is present — it does not verify the signature, so a forged
 * cookie gets past it. That is fine, and deliberate: the docs warn against
 * relying on shared modules here (Proxy may run ahead of the app, even on a
 * CDN), so pulling Prisma and the whole auth config into it would be the wrong
 * shape. Real verification happens in `requireUser` / `requireApiUser`, which
 * every protected page and route calls, and which validate the cookie properly.
 * Getting past this file buys an attacker nothing.
 */

/** Auth.js v5 cookie names — the `__Secure-` form is used over HTTPS. */
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

export function proxy(request: NextRequest) {
  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (hasSessionCookie) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  // Preserve the destination so login can return them to it.
  loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);

  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * Page routes only.
   *
   * `/api/*` is excluded on purpose. Redirecting an API call to an HTML login
   * page gives `fetch` a 307 it silently follows and then fails to parse as
   * JSON, so an expired session surfaces as "can't reach the server" instead of
   * "you're signed out". Every API route calls `requireApiUser` and answers 401
   * itself — **a new route under /api is not protected by this file, so it must
   * call `requireApiUser` (or `requireUser`) explicitly.**
   *
   * The login page is excluded so it can render, and static assets and the PWA
   * manifest/service worker so an install prompt isn't handed a redirect.
   */
  matcher: [
    "/((?!login|api|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js).*)",
  ],
};
