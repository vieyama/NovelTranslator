import Link from "next/link";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { AiSettingsForm } from "@/components/settings/AiSettingsForm";
import { OffPeakSettingsForm } from "@/components/settings/OffPeakSettingsForm";
import { getAiSettingsView } from "@/lib/ai-settings";
import { getOffPeakSettingsView } from "@/lib/offpeak-settings";
import { requireUser } from "@/lib/session";

/** Settings read live state (including whether a key is stored). */
export const dynamic = "force-dynamic";

export const metadata = { title: "Pengaturan — Novel Translator" };

export default async function SettingsPage() {
  const user = await requireUser("/settings");
  const [settings, offPeakSettings] = await Promise.all([
    getAiSettingsView(user.id),
    getOffPeakSettingsView(user.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/books"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Perpustakaan
        </Link>
        <SignOutButton />
      </div>

      <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Pengaturan</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Masuk sebagai <span className="font-medium">{user.email}</span>.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-50">AI</h2>
        <p className="mt-1 max-w-prose text-sm text-zinc-500">
          Provider, model, dan API key yang dipakai untuk menerjemahkan. API key disimpan
          terenkripsi di database dan hanya didekripsi saat batch terjemahan dijalankan — tidak
          pernah dikirim kembali ke browser.
        </p>

        <AiSettingsForm initial={settings} />
      </section>

      <section className="mt-12 border-t border-zinc-200 pt-8 dark:border-zinc-800">
        <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-50">Otomatisasi off-peak</h2>
        <p className="mt-1 max-w-prose text-sm text-zinc-500">
          Pilih buku milik akun ini untuk diterjemahkan otomatis dengan DeepSeek di luar jam
          01.00–04.00 dan 06.00–10.00 UTC pada hari kerja.
        </p>
        <OffPeakSettingsForm initial={offPeakSettings} />
      </section>
    </div>
  );
}
