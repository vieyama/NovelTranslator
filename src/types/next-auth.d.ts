import type { DefaultSession } from "next-auth";

/**
 * `session.user.id` is set by the session callback in `src/auth.ts`, but
 * NextAuth's own `DefaultSession["user"]` has no `id`. Without this
 * declaration every call site would need a cast, and the id is the value the
 * whole per-user data scoping depends on — it should be typed once, here.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}
