// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Prisma.
import "server-only";

import { prisma } from "@/lib/db";
import type { GlossaryTermRecord } from "@/lib/glossary-schema";

/**
 * Per-book terminology CRUD (GLOSSARY.md).
 *
 * These terms are injected into every translation request by
 * `src/lib/translator/prompt.ts`, so the same name renders the same way in
 * batch 3 and batch 12.
 *
 * Server-only — this module imports Prisma. Client components must import the
 * category list and `GlossaryTermRecord` from `@/lib/glossary-schema` instead.
 */

export type { GlossaryTermRecord };

export interface GlossaryTermInput {
  term?: unknown;
  translation?: unknown;
  category?: unknown;
  note?: unknown;
}

export class GlossaryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GlossaryError";
  }
}

export async function listGlossaryTerms(bookId: string): Promise<GlossaryTermRecord[]> {
  await assertBookExists(bookId);

  return prisma.glossaryTerm.findMany({
    where: { bookId },
    orderBy: { term: "asc" },
    select: { id: true, term: true, translation: true, category: true, note: true },
  });
}

export async function createGlossaryTerm(
  bookId: string,
  input: GlossaryTermInput,
): Promise<GlossaryTermRecord> {
  await assertBookExists(bookId);

  const term = requireTerm(input.term);
  await assertTermIsFree(bookId, term);

  return prisma.glossaryTerm.create({
    data: {
      bookId,
      term,
      translation: optionalText(input.translation, "translation"),
      category: optionalText(input.category, "category"),
      note: optionalText(input.note, "note"),
    },
    select: { id: true, term: true, translation: true, category: true, note: true },
  });
}

export async function updateGlossaryTerm(
  bookId: string,
  termId: string,
  input: GlossaryTermInput,
): Promise<GlossaryTermRecord> {
  const existing = await prisma.glossaryTerm.findFirst({
    where: { id: termId, bookId },
    select: { id: true, term: true },
  });

  if (!existing) {
    throw new GlossaryError("Glossary term not found.", 404);
  }

  const data: Record<string, string | null> = {};

  if (input.term !== undefined) {
    const term = requireTerm(input.term);

    if (term !== existing.term) {
      await assertTermIsFree(bookId, term);
      data.term = term;
    }
  }

  // Each field is only touched when present, so a partial PATCH can clear one
  // field (`null`) without wiping the others.
  if (input.translation !== undefined) data.translation = optionalText(input.translation, "translation");
  if (input.category !== undefined) data.category = optionalText(input.category, "category");
  if (input.note !== undefined) data.note = optionalText(input.note, "note");

  return prisma.glossaryTerm.update({
    where: { id: termId },
    data,
    select: { id: true, term: true, translation: true, category: true, note: true },
  });
}

export async function deleteGlossaryTerm(bookId: string, termId: string): Promise<void> {
  const existing = await prisma.glossaryTerm.findFirst({
    where: { id: termId, bookId },
    select: { id: true },
  });

  if (!existing) {
    throw new GlossaryError("Glossary term not found.", 404);
  }

  await prisma.glossaryTerm.delete({ where: { id: termId } });
}

async function assertBookExists(bookId: string): Promise<void> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { id: true } });

  if (!book) {
    throw new GlossaryError(`Book ${bookId} not found.`, 404);
  }
}

/** `[bookId, term]` is unique in the schema; check first for a clear 409. */
async function assertTermIsFree(bookId: string, term: string): Promise<void> {
  const clash = await prisma.glossaryTerm.findFirst({
    where: { bookId, term },
    select: { id: true },
  });

  if (clash) {
    throw new GlossaryError(`"${term}" is already in this book's glossary.`, 409);
  }
}

function requireTerm(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GlossaryError("`term` is required.", 400);
  }

  const term = value.trim();

  if (term.length > 200) {
    throw new GlossaryError("`term` is too long (max 200 characters).", 400);
  }

  return term;
}

/** Empty string and null both mean "no value" — for `translation` that reads as "keep unchanged". */
function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== "string") {
    throw new GlossaryError(`\`${field}\` must be a string or null.`, 400);
  }

  const trimmed = value.trim();

  if (trimmed.length > 500) {
    throw new GlossaryError(`\`${field}\` is too long (max 500 characters).`, 400);
  }

  return trimmed === "" ? null : trimmed;
}
