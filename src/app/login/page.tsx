import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/LoginForm";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata = { title: "Masuk — Novel Translator" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  // Already signed in: nothing to do here.
  if (await getSessionUser()) redirect(safeNext(next));

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Masuk</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Novel Translator — perpustakaan dan progres baca kamu.
      </p>

      <LoginForm next={safeNext(next)} initialError={error ? "Email atau kata sandi salah." : null} />
    </div>
  );
}

/**
 * Only same-site paths are accepted as a post-login destination.
 *
 * `?next=https://elsewhere.example` would otherwise make this login page an
 * open redirect — a phisher could link to our own domain and still land the
 * victim on their site after a successful sign-in. Anything not starting with
 * a single `/` falls back to the library. `//host` is rejected too: browsers
 * read it as protocol-relative and it would leave the site.
 */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/books";
  return next;
}
