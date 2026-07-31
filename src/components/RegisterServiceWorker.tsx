"use client";

import { useEffect } from "react";

/**
 * Registers the offline-caching service worker (`public/sw.js`, SPEC.md
 * §3.5). Production-only: a service worker caching hashed JS chunks fights
 * `next dev`'s hot-reload, serving stale bundles after every edit.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  }, []);

  return null;
}
