"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

/**
 * Email + password sign-in.
 *
 * `redirect: false` so a failed attempt can be shown inline instead of bouncing
 * through `/login?error=…` and losing what was typed.
 */
export function LoginForm({
  next,
  initialError,
}: {
  next: string;
  initialError: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(initialError);

  async function login(form: FormData) {
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    if (email === "" || password === "") {
      setError("Email dan kata sandi wajib diisi.");
      return;
    }

    setError(null);

    const result = await signIn("credentials", { email, password, redirect: false });

    if (!result || result.error) {
      // Deliberately not "email not found" vs "wrong password" — that
      // distinction tells an attacker which addresses have accounts.
      setError("Email atau kata sandi salah.");
      return;
    }

    // `refresh` first so the server components re-render with the new session
    // before the destination is rendered.
    router.refresh();
    router.replace(next);
  }

  return (
    <form action={login} className="mt-6 flex flex-col gap-4">
      <label className="block text-sm text-zinc-700 dark:text-zinc-300">
        Email
        <input
          type="email"
          name="email"
          autoComplete="username"
          required
          className="mt-1 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </label>

      <label className="block text-sm text-zinc-700 dark:text-zinc-300">
        Kata sandi
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          className="mt-1 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}

/**
 * Separate component so `useFormStatus` sees the parent form — called in
 * `LoginForm` itself it would always report `pending: false`, and a `useState`
 * flag set inside the action never renders at all (CLAUDE.md).
 */
function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {pending ? "Memproses…" : "Masuk"}
    </button>
  );
}
