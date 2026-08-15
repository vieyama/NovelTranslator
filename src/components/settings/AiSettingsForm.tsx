"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

import {
  AI_PROVIDERS,
  CUSTOM_MODEL,
  defaultModelFor,
  type AiProviderName,
  type AiSettingsView,
} from "@/lib/ai-settings-schema";

import { ApiKeyList } from "./ApiKeyList";

/**
 * AI provider / model / API key settings (SPEC.md §8).
 *
 * The model list is derived from the selected provider, so switching provider
 * re-points the whole form at that provider's stored model and key. Settings
 * are kept per provider server-side, which is why switching back restores what
 * was there rather than showing an empty form.
 *
 * The API key field starts empty even when a key is stored: the plaintext is
 * never sent to the browser, only a mask like `sk-a…dY3f`. Leaving it empty on
 * save means "keep the stored key".
 */
export function AiSettingsForm({ initial }: { initial: AiSettingsView }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [provider, setProvider] = useState<AiProviderName>(initial.activeProvider);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const meta = AI_PROVIDERS.find((p) => p.value === provider) ?? AI_PROVIDERS[0];
  const current = settings.providers.find((p) => p.provider === provider);

  const knownModels = meta.models.map((m) => m.value) as readonly string[];
  const storedModel = current?.model ?? null;
  const storedIsCustom = storedModel !== null && !knownModels.includes(storedModel);

  const [modelChoice, setModelChoice] = useState<string>(
    storedIsCustom ? CUSTOM_MODEL : (storedModel ?? ""),
  );
  const [customModel, setCustomModel] = useState<string>(storedIsCustom ? storedModel : "");

  /** Re-point the form when the provider changes, without an effect. */
  function switchProvider(next: AiProviderName) {
    const nextSettings = settings.providers.find((p) => p.provider === next);
    const nextModel = nextSettings?.model ?? null;
    const nextKnown = (AI_PROVIDERS.find((p) => p.value === next) ?? AI_PROVIDERS[0]).models.map(
      (m) => m.value,
    ) as readonly string[];
    const isCustom = nextModel !== null && !nextKnown.includes(nextModel);

    setProvider(next);
    setModelChoice(isCustom ? CUSTOM_MODEL : (nextModel ?? ""));
    setCustomModel(isCustom ? nextModel : "");
    setError(null);
    setSaved(null);
  }

  async function save() {
    setError(null);
    setSaved(null);

    const model = modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice;
    const payload: Record<string, unknown> = { provider, model };

    try {
      const response = await fetch("/api/settings/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Gagal menyimpan pengaturan.");
        return;
      }

      setSettings(data.settings);
      setSaved("Pengaturan tersimpan.");
      // The reader's translate button depends on these, so refresh the server
      // components that read them.
      router.refresh();
    } catch {
      setError("Tidak bisa menghubungi server.");
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-8">
      <form action={save} className="flex flex-col gap-6">
      {!settings.encryptionReady && (
        <p
          role="alert"
          className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <strong className="font-medium">APP_ENCRYPTION_KEY belum diset di server.</strong> API key
          tidak bisa disimpan sampai variabel itu ada, karena kuncinya wajib dienkripsi sebelum
          masuk database.
        </p>
      )}

      <label className="block text-sm text-zinc-700 dark:text-zinc-300">
        Provider
        <select
          value={provider}
          onChange={(event) => switchProvider(event.target.value as AiProviderName)}
          className="mt-1 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        >
          {AI_PROVIDERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div>
        <label className="block text-sm text-zinc-700 dark:text-zinc-300">
          Model
          <select
            value={modelChoice}
            onChange={(event) => setModelChoice(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="">Default ({defaultModelFor(provider)})</option>
            {meta.models.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Model lain (isi manual)…</option>
          </select>
        </label>

        {/* An escape hatch so a model released after this list was written can
            still be used without a code change. */}
        {modelChoice === CUSTOM_MODEL && (
          <input
            type="text"
            value={customModel}
            onChange={(event) => setCustomModel(event.target.value)}
            placeholder="mis. claude-opus-5-20260101"
            aria-label="Nama model"
            className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 font-mono text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {saved && <p className="text-sm text-emerald-700 dark:text-emerald-400">{saved}</p>}

      <SubmitButton />
    </form>

      {/* A sibling of the form, not a child: nested forms are invalid HTML and
          its buttons would submit the settings form instead. */}
      <ApiKeyList
        provider={provider}
        providerLabel={meta.label}
        keyHint={meta.keyHint}
        keyPlaceholder={meta.keyPlaceholder}
        keys={current?.keys ?? []}
        hasEnvFallback={current?.hasEnvFallback ?? false}
        disabled={!settings.encryptionReady}
        onChanged={setSettings}
      />
    </div>
  );
}

/** Child component so `useFormStatus` reads the parent form (CLAUDE.md). */
function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 self-start rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {pending ? "Menyimpan…" : "Simpan"}
    </button>
  );
}
