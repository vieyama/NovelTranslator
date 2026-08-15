"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import type { AiProviderName, AiSettingsView, SavedApiKey } from "@/lib/ai-settings-schema";

/**
 * Saved API keys for one provider (SPEC.md §8.5).
 *
 * Several keys per provider exists because free tiers run out: when one is
 * exhausted the fix should be picking another, not finding the other key
 * wherever it was kept and pasting it in again.
 *
 * Deliberately **not** rendered inside the provider/model `<form>`: nested
 * forms are invalid HTML, and its buttons would submit the settings form
 * instead of doing their own job.
 *
 * The plaintext key is never here — only a mask derived server-side, plus the
 * label, which is the only way to tell two masked keys apart.
 */
export function ApiKeyList({
  provider,
  providerLabel,
  keyHint,
  keyPlaceholder,
  keys,
  hasEnvFallback,
  disabled,
  onChanged,
}: {
  provider: AiProviderName;
  providerLabel: string;
  keyHint: string;
  keyPlaceholder: string;
  keys: SavedApiKey[];
  hasEnvFallback: boolean;
  disabled: boolean;
  onChanged: (settings: AiSettingsView) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);

  async function call(
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
  ): Promise<boolean> {
    setError(null);

    try {
      const response = await fetch("/api/settings/ai/keys", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Gagal memproses API key.");
        return false;
      }

      onChanged(data.settings);
      return true;
    } catch {
      setError("Tidak bisa menghubungi server.");
      return false;
    }
  }

  async function addKey(form: FormData) {
    const apiKey = String(form.get("apiKey") ?? "").trim();
    const label = String(form.get("label") ?? "").trim();

    if (apiKey === "") {
      setError("API key tidak boleh kosong.");
      return;
    }

    if (await call("POST", { provider, apiKey, label })) {
      // Clear the pasted secret from the DOM as soon as it is stored.
      (document.getElementById(`add-key-${provider}`) as HTMLFormElement | null)?.reset();
    }
  }

  async function withBusy(keyId: string, run: () => Promise<unknown>) {
    setBusyKeyId(keyId);
    try {
      await run();
    } finally {
      setBusyKeyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          API key {providerLabel}
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          Simpan beberapa kunci sekaligus. Kalau kuota satu kunci habis, tinggal pilih{" "}
          <span className="font-medium">Pakai</span> pada kunci lain — tidak perlu menempel ulang.
        </p>
      </div>

      {keys.length === 0 ? (
        <p className="text-xs text-zinc-500">
          {hasEnvFallback ? (
            <>Belum ada kunci pribadi — sementara memakai kunci server dari environment.</>
          ) : (
            <>
              Belum ada API key. Ambil dari <span className="font-mono">{keyHint}</span>.
            </>
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {keys.map((key) => (
            <li
              key={key.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs ${
                key.isActive
                  ? "border-emerald-500/60 bg-emerald-50/50 dark:bg-emerald-950/20"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{key.label}</span>

              {key.maskedApiKey ? (
                <code className="font-mono text-zinc-500">{key.maskedApiKey}</code>
              ) : (
                <span className="text-amber-700 dark:text-amber-400" title="APP_ENCRYPTION_KEY mungkin berubah">
                  tidak terbaca
                </span>
              )}

              {key.isActive && (
                <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[0.65rem] font-medium text-white">
                  DIPAKAI
                </span>
              )}

              {/* Date only, sliced straight from the ISO string: a locale-
                  formatted time would differ between server and client render
                  and trip a hydration mismatch. Enough to spot a stale key. */}
              <span className="text-zinc-400 dark:text-zinc-600" title={key.lastUsedAt ?? undefined}>
                {key.lastUsedAt ? `dipakai ${key.lastUsedAt.slice(0, 10)}` : "belum pernah dipakai"}
              </span>

              <span className="ml-auto flex items-center gap-3">
                {!key.isActive && (
                  <button
                    type="button"
                    disabled={busyKeyId !== null}
                    onClick={() => withBusy(key.id, () => call("PATCH", { keyId: key.id }))}
                    className="rounded font-medium text-emerald-700 underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-70 dark:text-emerald-400"
                  >
                    {busyKeyId === key.id ? "…" : "Pakai"}
                  </button>
                )}

                <button
                  type="button"
                  disabled={busyKeyId !== null}
                  onClick={() => {
                    if (!confirm(`Hapus kunci "${key.label}"? Kunci aslinya tidak bisa dipulihkan dari sini.`)) return;
                    void withBusy(key.id, () => call("DELETE", { keyId: key.id }));
                  }}
                  className="rounded text-zinc-400 underline-offset-2 hover:text-red-700 hover:underline disabled:cursor-wait dark:hover:text-red-400"
                >
                  Hapus
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        id={`add-key-${provider}`}
        action={addKey}
        className="flex flex-col gap-2 rounded-md border border-dashed border-zinc-300 p-3 dark:border-zinc-700"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            name="label"
            placeholder="Nama (opsional), mis. Akun cadangan"
            disabled={disabled}
            className="min-h-11 flex-1 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <input
            type="password"
            name="apiKey"
            autoComplete="off"
            placeholder={keyPlaceholder}
            disabled={disabled}
            className="min-h-11 flex-1 rounded-md border border-zinc-300 bg-white px-3 font-mono text-sm text-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </div>

        <AddButton disabled={disabled} />
      </form>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

/** Child component so `useFormStatus` reads the add-key form (CLAUDE.md). */
function AddButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="min-h-11 self-start rounded-md border border-zinc-300 px-3 text-sm text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
    >
      {pending ? "Menyimpan…" : "+ Tambah kunci"}
    </button>
  );
}
