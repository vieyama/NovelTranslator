import type { MetadataRoute } from "next";

/**
 * Web app manifest (SPEC.md §3.5) — auto-linked into <head> by Next.js's
 * `app/manifest.ts` file convention, no manual <link rel="manifest"> needed.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Novel Translator",
    short_name: "Novel Translator",
    description: "Baca novel Inggris dengan terjemahan Indonesia dan progres otomatis.",
    start_url: "/books",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      {
        // Static file under public/, not a Next-generated icon route — the
        // manifest needs a stable, self-referenced URL (Next's app/icon.*
        // convention hashes its URL in production, which the manifest can't
        // predict).
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
