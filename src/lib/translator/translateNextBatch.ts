// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Prisma + API clients.
import "server-only";

import { prisma } from "@/lib/db";

import { parseTranslationResponse } from "./parseResponse";
import { buildPrompt } from "./prompt";
import { resolveProvider } from "./provider";
import { TranslationError, type TranslationProvider } from "./types";

/**
 * Translates the next batch of a book (SPEC.md §3.2).
 *
 * The invariant that governs this whole file: `lastTranslatedIndex` only ever
 * advances over paragraphs that are actually translated and stored. Any failure
 * — provider error, refusal, paragraph-count mismatch — leaves both the
 * paragraphs and the progress row untouched, so a retry is always safe
 * (CLAUDE.md → Non-Negotiables).
 */

const DEFAULT_MAX_CHARS = 3000;

/** Upper bound on rows pulled per call; far beyond any realistic batch. */
const CANDIDATE_LIMIT = 1000;

export interface TranslateNextBatchInput {
  bookId: string;
  maxChars?: number;
  /** Defaults to whatever `TRANSLATION_PROVIDER` selects. */
  provider?: TranslationProvider;
}

export interface TranslatedParagraph {
  orderIndex: number;
  originalText: string;
  translatedText: string;
}

export interface TranslateNextBatchResult {
  /** True when there is nothing left to translate — `paragraphs` is then empty. */
  done: boolean;
  paragraphs: TranslatedParagraph[];
  progress: {
    lastTranslatedIndex: number;
    lastReadIndex: number;
    totalParagraphs: number;
  };
  /** Which provider handled the batch — `"claude"` or `"gemini"`. */
  provider?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export async function translateNextBatch({
  bookId,
  maxChars,
  provider = resolveProvider(),
}: TranslateNextBatchInput): Promise<TranslateNextBatchResult> {
  const effectiveMaxChars = resolveMaxChars(maxChars);

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    include: { progress: true, glossaryTerms: { orderBy: { term: "asc" } } },
  });

  if (!book) {
    throw new TranslationError(`Book ${bookId} not found.`, "provider_error", 404);
  }

  const lastTranslatedIndex = book.progress?.lastTranslatedIndex ?? -1;
  const lastReadIndex = book.progress?.lastReadIndex ?? -1;

  const { pending, resumeIndex } = await findPendingRun(bookId, lastTranslatedIndex);

  if (pending.length === 0) {
    // Nothing to send. If the only thing ahead was already-translated text
    // (e.g. seeded data), move the index over it — that's bookkeeping, not a
    // claim about untranslated work.
    const settledIndex = await syncProgress(bookId, resumeIndex, lastTranslatedIndex);

    return {
      done: true,
      paragraphs: [],
      progress: {
        lastTranslatedIndex: settledIndex,
        lastReadIndex,
        totalParagraphs: book.totalParagraphs,
      },
    };
  }

  const batch = groupIntoBatch(pending, effectiveMaxChars);

  const request = await buildPrompt({
    paragraphs: batch.map((paragraph) => paragraph.originalText),
    glossaryTerms: book.glossaryTerms,
  });

  const response = await provider.translateBatch(request);
  const parsed = parseTranslationResponse(response.text, batch.length);

  if (!parsed.ok) {
    // Deliberately thrown before any write: a mismatched count means we cannot
    // map translations to orderIndex safely.
    throw new TranslationError(parsed.error, "count_mismatch");
  }

  const translatedAt = new Date();
  const lastIndexInBatch = batch[batch.length - 1].orderIndex;

  await prisma.$transaction(async (tx) => {
    for (const [position, paragraph] of batch.entries()) {
      await tx.paragraph.update({
        where: { id: paragraph.id },
        data: { translatedText: parsed.paragraphs[position], translatedAt },
      });
    }

    await tx.readingProgress.update({
      where: { bookId },
      data: { lastTranslatedIndex: lastIndexInBatch },
    });
  });

  return {
    done: false,
    paragraphs: batch.map((paragraph, position) => ({
      orderIndex: paragraph.orderIndex,
      originalText: paragraph.originalText,
      translatedText: parsed.paragraphs[position],
    })),
    progress: {
      lastTranslatedIndex: lastIndexInBatch,
      lastReadIndex,
      totalParagraphs: book.totalParagraphs,
    },
    provider: provider.id,
    model: response.model,
    usage: response.usage,
  };
}

interface PendingParagraph {
  id: string;
  orderIndex: number;
  originalText: string;
  charCount: number;
}

/**
 * Returns the first *contiguous* run of untranslated paragraphs after
 * `lastTranslatedIndex`, plus the index that run starts from.
 *
 * Contiguity matters: `lastTranslatedIndex` is a single watermark, so it may
 * only advance across a block that is fully translated. Skipping over an
 * untranslated paragraph would strand it behind the watermark forever.
 */
async function findPendingRun(bookId: string, lastTranslatedIndex: number) {
  const candidates = await prisma.paragraph.findMany({
    where: { bookId, orderIndex: { gt: lastTranslatedIndex } },
    orderBy: { orderIndex: "asc" },
    take: CANDIDATE_LIMIT,
    select: { id: true, orderIndex: true, originalText: true, charCount: true, translatedText: true },
  });

  let cursor = 0;
  let resumeIndex = lastTranslatedIndex;

  // Step over anything already translated sitting directly ahead of the watermark.
  while (cursor < candidates.length && candidates[cursor].translatedText !== null) {
    resumeIndex = candidates[cursor].orderIndex;
    cursor += 1;
  }

  const pending: PendingParagraph[] = [];

  for (; cursor < candidates.length; cursor += 1) {
    const candidate = candidates[cursor];
    if (candidate.translatedText !== null) break;

    pending.push({
      id: candidate.id,
      orderIndex: candidate.orderIndex,
      originalText: candidate.originalText,
      charCount: candidate.charCount,
    });
  }

  return { pending, resumeIndex };
}

/**
 * Groups consecutive paragraphs up to `maxChars`.
 *
 * A paragraph is never split. One that exceeds `maxChars` on its own is sent
 * whole and alone — splitting it would break sentence context
 * (CLAUDE.md → "Batching for translation").
 */
export function groupIntoBatch(
  paragraphs: PendingParagraph[],
  maxChars: number,
): PendingParagraph[] {
  const batch: PendingParagraph[] = [];
  let total = 0;

  for (const paragraph of paragraphs) {
    if (batch.length > 0 && total + paragraph.charCount > maxChars) break;

    batch.push(paragraph);
    total += paragraph.charCount;
  }

  return batch;
}

/** Advances the watermark over already-translated paragraphs, if any. */
async function syncProgress(
  bookId: string,
  resumeIndex: number,
  lastTranslatedIndex: number,
): Promise<number> {
  if (resumeIndex <= lastTranslatedIndex) return lastTranslatedIndex;

  await prisma.readingProgress.update({
    where: { bookId },
    data: { lastTranslatedIndex: resumeIndex },
  });

  return resumeIndex;
}

function resolveMaxChars(requested?: number): number {
  const configured = Number.parseInt(process.env.DEFAULT_MAX_CHARS ?? "", 10);
  const fallback = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_CHARS;
  const value = requested ?? fallback;

  if (!Number.isFinite(value) || value <= 0) {
    throw new TranslationError("`maxChars` must be a positive number.", "provider_error", 400);
  }

  return Math.floor(value);
}
