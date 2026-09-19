"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import type { OffPeakSettingsView } from "@/lib/offpeak-settings-schema";

export function OffPeakSettingsForm({ initial }: { initial: OffPeakSettingsView }) {
  const [settings, setSettings] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [bookId, setBookId] = useState(initial.bookId);
  const [maxChars, setMaxChars] = useState(initial.maxChars);
  const [maxBatches, setMaxBatches] = useState(initial.maxBatches);
  const [delayMs, setDelayMs] = useState(initial.delayMsBetweenBatches);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function save() {
    setError(null);
    setSaved(null);
    try {
      const response = await fetch("/api/settings/offpeak", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          bookId,
          maxChars,
          maxBatches,
          delayMsBetweenBatches: delayMs,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "Gagal menyimpan otomatisasi.");
        return;
      }
      setSettings(data.settings);
      setSaved("Otomatisasi tersimpan.");
    } catch {
      setError("Tidak bisa menghubungi server.");
    }
  }

  const hasBooks = settings.books.length > 0;

  return (
    <form action={save} className="mt-6 flex flex-col gap-5">
      {!hasBooks && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Unggah buku terlebih dahulu sebelum mengaktifkan otomatisasi.
        </p>
      )}

      <div className="flex min-h-11 items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Terjemahan DeepSeek off-peak
          </p>
          <p className="text-xs text-zinc-500">{enabled ? "Aktif" : "Nonaktif"}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Aktifkan terjemahan DeepSeek off-peak"
          disabled={!hasBooks}
          onClick={() => setEnabled((current) => !current)}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:outline-zinc-100 ${
            enabled ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-1 size-5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>

      <label className="block text-sm text-zinc-700 dark:text-zinc-300">
        Buku
        <select
          value={bookId}
          onChange={(event) => setBookId(event.target.value)}
          disabled={!hasBooks}
          className="mt-1 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        >
          {settings.books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.title}
            </option>
          ))}
        </select>
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField
          label="Karakter per batch"
          value={maxChars}
          min={100}
          max={100000}
          onChange={setMaxChars}
        />
        <NumberField
          label="Batch per eksekusi"
          value={maxBatches}
          min={1}
          max={10000}
          onChange={setMaxBatches}
        />
        <NumberField
          label="Jeda (milidetik)"
          value={delayMs}
          min={0}
          max={60000}
          onChange={setDelayMs}
        />
      </div>

      {settings.lastRunAt && (
        <p className="text-xs text-zinc-500">
          Eksekusi terakhir: {settings.lastRunAt.replace("T", " ").slice(0, 19)} UTC
        </p>
      )}
      {settings.lastError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          Error terakhir: {settings.lastError}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {saved && <p className="text-sm text-emerald-700 dark:text-emerald-400">{saved}</p>}

      <SubmitButton disabled={!hasBooks} />
    </form>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-sm text-zinc-700 dark:text-zinc-300">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className="mt-1 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
    </label>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="min-h-11 self-start rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {pending ? "Menyimpan…" : "Simpan otomatisasi"}
    </button>
  );
}
