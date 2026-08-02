// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Prisma + API clients.
import "server-only";

import { prisma } from "@/lib/db";

import { parseTranslationResponse } from "./parseResponse";
import { buildPrompt } from "./prompt";
import { resolveAiConfig } from "@/lib/ai-settings";
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
  /**
   * Translate starting at this paragraph instead of continuing from
   * `lastTranslatedIndex`. Anything still untranslated between the watermark
   * and this index is left untouched (not skipped forever — a later call,
   * from either the watermark or another explicit index, fills it in and the
   * watermark catches up automatically, see `advanceWatermark`).
   */
  fromIndex?: number;
  /** Owner of the book; scopes the lookup and selects whose API key is used. */
  userId: string;
  /** Defaults to the provider resolved from the user's settings. */
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
  userId,
  maxChars,
  fromIndex,
  provider,
}: TranslateNextBatchInput): Promise<TranslateNextBatchResult> {
  const effectiveMaxChars = resolveMaxChars(maxChars);

  // Scoped by owner: translating someone else's book reads as "not found",
  // and spending their API budget is not possible (SPEC.md §8).
  const book = await prisma.book.findFirst({
    where: { id: bookId, userId },
    include: { progress: true, glossaryTerms: { orderBy: { term: "asc" } } },
  });

  if (!book) {
    throw new TranslationError(`Book ${bookId} not found.`, "provider_error", 404);
  }

  // Resolved after the ownership check so a probe can't tell a missing book
  // from a missing API key.
  const activeProvider = provider ?? (await resolveProviderForUser(userId));

  if (
    fromIndex !== undefined &&
    (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > book.totalParagraphs - 1)
  ) {
    throw new TranslationError(
      `\`fromIndex\` must be an integer between 0 and ${book.totalParagraphs - 1}.`,
      "provider_error",
      400,
    );
  }

  const lastTranslatedIndex = book.progress?.lastTranslatedIndex ?? -1;
  const lastReadIndex = book.progress?.lastReadIndex ?? -1;

  // Normally the anchor is the watermark; an explicit `fromIndex` anchors the
  // search there instead, so the run can start ahead of a still-untranslated gap.
  const anchor = fromIndex !== undefined ? fromIndex - 1 : lastTranslatedIndex;
  const pending = await findPendingRun(bookId, anchor);

  if (pending.length === 0) {
    // Nothing to send from the anchor onward. If that's only true because
    // paragraphs there were already translated out of order (seeded data, or
    // an earlier explicit `fromIndex` batch), let the watermark catch up —
    // that's bookkeeping, not a claim about untranslated work.
    const settledIndex = await advanceWatermark(
      prisma,
      bookId,
      lastTranslatedIndex,
      book.totalParagraphs,
    );

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

  const response = await activeProvider.translateBatch(request);
  const parsed = parseTranslationResponse(response.text, batch.length);

  if (!parsed.ok) {
    // Deliberately thrown before any write: a mismatched count means we cannot
    // map translations to orderIndex safely.
    throw new TranslationError(parsed.error, "count_mismatch");
  }

  const translatedAt = new Date();

  const newWatermark = await prisma.$transaction(async (tx) => {
    for (const [position, paragraph] of batch.entries()) {
      await tx.paragraph.update({
        where: { id: paragraph.id },
        data: { translatedText: parsed.paragraphs[position], translatedAt },
      });
    }

    return advanceWatermark(tx, bookId, lastTranslatedIndex, book.totalParagraphs);
  });

  return {
    done: false,
    paragraphs: batch.map((paragraph, position) => ({
      orderIndex: paragraph.orderIndex,
      originalText: paragraph.originalText,
      translatedText: parsed.paragraphs[position],
    })),
    progress: {
      lastTranslatedIndex: newWatermark,
      lastReadIndex,
      totalParagraphs: book.totalParagraphs,
    },
    provider: activeProvider.id,
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
 * `anchor` (normally the watermark, but an explicit `fromIndex` anchors the
 * search ahead of it instead — see `translateNextBatch`).
 *
 * Contiguity matters within the run itself: a paragraph already translated
 * ends the run, since batching further paragraphs together with it would mean
 * re-sending already-translated text.
 */
async function findPendingRun(bookId: string, anchor: number): Promise<PendingParagraph[]> {
  const candidates = await prisma.paragraph.findMany({
    where: { bookId, orderIndex: { gt: anchor } },
    orderBy: { orderIndex: "asc" },
    take: CANDIDATE_LIMIT,
    select: { id: true, orderIndex: true, originalText: true, charCount: true, translatedText: true },
  });

  const pending: PendingParagraph[] = [];

  for (const candidate of candidates) {
    if (candidate.translatedText !== null) {
      // Already translated: skip if it's sitting ahead of `anchor` (an
      // explicit `fromIndex` may point at or before already-translated text),
      // but never batch past it — that would mean re-sending translated text.
      if (pending.length > 0) break;
      continue;
    }

    pending.push({
      id: candidate.id,
      orderIndex: candidate.orderIndex,
      originalText: candidate.originalText,
      charCount: candidate.charCount,
    });
  }

  return pending;
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

/**
 * Recomputes the watermark as "last index before the next untranslated gap",
 * and persists it if it moved.
 *
 * This is what lets `lastTranslatedIndex` catch up over paragraphs translated
 * out of order (via an explicit `fromIndex`, or seeded data): it doesn't
 * assume the just-written batch is what advances the watermark — it always
 * looks at actual DB state, so a later batch that happens to close an earlier
 * gap advances the watermark past that whole now-contiguous stretch in one go.
 * Pass a transaction client to read/write within the same transaction as the
 * paragraph writes that produced the new state.
 */
async function advanceWatermark(
  db: Pick<typeof prisma, "paragraph" | "readingProgress">,
  bookId: string,
  lastTranslatedIndex: number,
  totalParagraphs: number,
): Promise<number> {
  const nextGap = await db.paragraph.findFirst({
    where: { bookId, orderIndex: { gt: lastTranslatedIndex }, translatedText: null },
    orderBy: { orderIndex: "asc" },
    select: { orderIndex: true },
  });

  const watermark = nextGap ? nextGap.orderIndex - 1 : totalParagraphs - 1;

  if (watermark !== lastTranslatedIndex) {
    await db.readingProgress.update({ where: { bookId }, data: { lastTranslatedIndex: watermark } });
  }

  return watermark;
}

/**
 * Builds the provider for this user from their stored settings — provider,
 * model, and a decrypted API key (falling back to the server env vars when
 * they haven't configured their own).
 */
async function resolveProviderForUser(userId: string): Promise<TranslationProvider> {
  const config = await resolveAiConfig(userId);

  return resolveProvider({ apiKey: config.apiKey, model: config.model }, config.provider);
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
