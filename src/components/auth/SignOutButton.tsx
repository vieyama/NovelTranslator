"use client";

import { signOut } from "next-auth/react";
import { useFormStatus } from "react-dom";

/** Clears the session cookie and returns to the login page. */
export function SignOutButton() {
  return (
    <form action={() => signOut({ redirectTo: "/login" })}>
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-wait disabled:opacity-70 dark:hover:text-zinc-100"
    >
      {pending ? "Keluar…" : "Keluar"}
    </button>
  );
}
