/**
 * Glossary vocabulary and shapes shared by client and server.
 *
 * Kept separate from `glossary.ts` on purpose: that module imports Prisma
 * (and the `pg` driver, a Node-only module) into any bundle that touches it.
 * A `"use client"` component importing from here stays browser-safe.
 */

/** Mirrors the naming rules in TRANSLATION_RULES.md; the UI offers these as hints. */
export const GLOSSARY_CATEGORIES = [
  "character",
  "place",
  "organization",
  "race",
  "skill",
  "item",
  "title",
  "honorific",
  "term",
] as const;

export interface GlossaryTermRecord {
  id: string;
  term: string;
  /** `null` means "keep unchanged" (GLOSSARY.md). */
  translation: string | null;
  category: string | null;
  note: string | null;
}
