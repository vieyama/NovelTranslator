/** How the reader renders each paragraph (SPEC.md §3.3). */
export type ViewMode = "translated" | "original" | "side-by-side";

export const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "translated", label: "Terjemahan" },
  { value: "original", label: "Asli" },
  { value: "side-by-side", label: "Berdampingan" },
];

const DEFAULT_VIEW_MODE: ViewMode = "translated";
const STORAGE_KEY = "novel-translator:view-mode";

export function isViewMode(value: unknown): value is ViewMode {
  return VIEW_MODES.some((mode) => mode.value === value);
}

/**
 * `localStorage` exposed as an external store, so the reader can restore the
 * last-used mode via `useSyncExternalStore` instead of a setState-in-effect
 * (which causes a cascading re-render).
 */
const listeners = new Set<() => void>();

/** Cached so `getSnapshot` returns a stable value between renders. */
let snapshot: ViewMode | null = null;

export function subscribeViewMode(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab changing the mode should update this one too.
  window.addEventListener("storage", onChange);

  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function getViewModeSnapshot(): ViewMode {
  if (snapshot === null) {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    snapshot = isViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
  }

  return snapshot;
}

/** The server has no localStorage; the client re-reads on hydration. */
export function getViewModeServerSnapshot(): ViewMode {
  return DEFAULT_VIEW_MODE;
}

export function setViewMode(mode: ViewMode): void {
  snapshot = mode;
  window.localStorage.setItem(STORAGE_KEY, mode);
  listeners.forEach((notify) => notify());
}
