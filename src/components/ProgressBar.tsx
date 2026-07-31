/** Two-track progress bar: translation runs ahead of reading (SPEC.md §2). */
export function ProgressBar({
  translatedPercent,
  readPercent,
}: {
  translatedPercent: number;
  readPercent: number;
}) {
  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      role="img"
      aria-label={`${translatedPercent}% translated, ${readPercent}% read`}
    >
      <div
        className="absolute inset-y-0 left-0 bg-emerald-500/40"
        style={{ width: `${translatedPercent}%` }}
      />
      <div
        className="absolute inset-y-0 left-0 bg-emerald-600"
        style={{ width: `${readPercent}%` }}
      />
    </div>
  );
}
