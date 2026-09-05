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
 * The invariant that governs this whole file: translation progress only moves
 * after paragraphs are actually translated and stored. Any failure — provider
 * error, refusal, paragraph-count mismatch — leaves both the paragraphs and the
 * progress row untouched, so a retry is always safe.
 */

const DEFAULT_MAX_CHARS = 3000;

/** Upper bound on rows pulled per call; far beyond any realistic batch. */
const CANDIDATE_LIMIT = 1000;

export interface TranslateNextBatchInput {
  bookId: string;
  maxChars?: number;
  /**
   * Translate starting at this paragraph instead of continuing after the latest
   * translated paragraph. Anything still untranslated before this index is left
   * untouched and can be filled with another explicit request later.
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
    lastTranslatedParagraphIndex: number;
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
  const effectiveMaxChars = resolveMaxChars(maxChars, activeProvider.id);

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
  const lastTranslatedParagraphIndex = book.progress?.lastTranslatedParagraphIndex ?? -1;
  const lastReadIndex = book.progress?.lastReadIndex ?? -1;

  // Normally the anchor is the latest translated position; an explicit
  // `fromIndex` anchors the search there instead.
  const anchor = fromIndex !== undefined ? fromIndex - 1 : lastTranslatedIndex;
  const pending = await findPendingRun(bookId, anchor);

  if (pending.length === 0) {
    // Nothing to send from the anchor onward. Recompute from actual paragraph
    // state so progress can settle after manual edits or seeded data.
    const settledProgress = await settleTranslationProgress(
      prisma,
      bookId,
      lastTranslatedIndex,
      lastTranslatedParagraphIndex,
    );

    return {
      done: true,
      paragraphs: [],
      progress: {
        ...settledProgress,
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
  const translatedBy = describeSource(activeProvider.id, response.model);

  const newWatermark = await prisma.$transaction(async (tx) => {
    for (const [position, paragraph] of batch.entries()) {
      await tx.paragraph.update({
        where: { id: paragraph.id },
        data: { translatedText: parsed.paragraphs[position], translatedAt, translatedBy },
      });
    }

    await incrementBookTokenUsage(tx, {
      bookId,
      provider: activeProvider.id,
      model: response.model,
      usage: response.usage,
    });

    return settleTranslationProgress(
      tx,
      bookId,
      lastTranslatedIndex,
      lastTranslatedParagraphIndex,
    );
  });

  return {
    done: false,
    paragraphs: batch.map((paragraph, position) => ({
      orderIndex: paragraph.orderIndex,
      originalText: paragraph.originalText,
      translatedText: parsed.paragraphs[position],
    })),
    progress: {
      ...newWatermark,
      lastReadIndex,
      totalParagraphs: book.totalParagraphs,
    },
    provider: activeProvider.id,
    model: response.model,
    usage: response.usage,
  };
}

/** Stored in `Paragraph.translatedBy` — "provider:model", e.g. "gemini:gemini-flash-latest". */
function describeSource(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

export interface RetranslateInput {
  bookId: string;
  userId: string;
  /** First paragraph to redo. The batch runs forward from here. */
  fromIndex: number;
  maxChars?: number;
  provider?: TranslationProvider;
}

export interface RetranslateResult {
  paragraphs: TranslatedParagraph[];
  provider: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Re-translates a batch of *already translated* paragraphs (SPEC.md §3.6).
 *
 * For when one model's output reads badly and another should be tried. Three
 * properties this has to keep:
 *
 * - **The old text survives a failure.** Nothing is written until the reply has
 *   come back and `parseTranslationResponse` has confirmed the paragraph count,
 *   and then it all lands in one transaction. A provider error or a mismatched
 *   separator count leaves the previous translation exactly where it was — the
 *   same contract as `translateNextBatch`.
 * - **The old text is kept, not discarded.** Each paragraph's current text
 *   moves to `previousTranslatedText` before being overwritten, so a worse
 *   result can be reverted per paragraph.
 * - **Progress never moves.** Re-translation only ever replaces non-null text,
 *   so the latest translated position is already represented. Recomputing it
 *   here would invite the belief that re-translation can fill gaps.
 */
export async function retranslateBatch({
  bookId,
  userId,
  fromIndex,
  maxChars,
  provider,
}: RetranslateInput): Promise<RetranslateResult> {
  const book = await prisma.book.findFirst({
    where: { id: bookId, userId },
    include: { glossaryTerms: { orderBy: { term: "asc" } } },
  });

  if (!book) {
    throw new TranslationError(`Book ${bookId} not found.`, "provider_error", 404);
  }

  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > book.totalParagraphs - 1) {
    throw new TranslationError(
      `\`fromIndex\` must be an integer between 0 and ${book.totalParagraphs - 1}.`,
      "provider_error",
      400,
    );
  }

  const activeProvider = provider ?? (await resolveProviderForUser(userId));
  const effectiveMaxChars = resolveMaxChars(maxChars, activeProvider.id);

  const run = await findTranslatedRun(bookId, fromIndex);

  if (run.length === 0) {
    throw new TranslationError(
      `Paragraf #${fromIndex} belum diterjemahkan, jadi tidak ada yang bisa diulang.`,
      "provider_error",
      400,
    );
  }

  const batch = groupIntoBatch(run, effectiveMaxChars);

  const request = await buildPrompt({
    paragraphs: batch.map((paragraph) => paragraph.originalText),
    glossaryTerms: book.glossaryTerms,
  });

  const response = await activeProvider.translateBatch(request);
  const parsed = parseTranslationResponse(response.text, batch.length);

  if (!parsed.ok) {
    throw new TranslationError(parsed.error, "count_mismatch");
  }

  const translatedAt = new Date();
  const translatedBy = describeSource(activeProvider.id, response.model);

  await prisma.$transaction(async (tx) => {
    for (const [position, paragraph] of batch.entries()) {
      await tx.paragraph.update({
        where: { id: paragraph.id },
        data: {
          // Demote the current text before overwriting it. `previousTranslatedText`
          // holds one level only: re-translating twice keeps the immediately
          // preceding version, not a full history.
          previousTranslatedText: paragraph.translatedText,
          previousTranslatedBy: paragraph.translatedBy,
          translatedText: parsed.paragraphs[position],
          translatedAt,
          translatedBy,
        },
      });
    }

    await incrementBookTokenUsage(tx, {
      bookId,
      provider: activeProvider.id,
      model: response.model,
      usage: response.usage,
    });
  });

  return {
    paragraphs: batch.map((paragraph, position) => ({
      orderIndex: paragraph.orderIndex,
      originalText: paragraph.originalText,
      translatedText: parsed.paragraphs[position],
    })),
    provider: activeProvider.id,
    model: response.model,
    usage: response.usage,
  };
}

/**
 * The contiguous run of *translated* paragraphs starting at `fromIndex`.
 *
 * The mirror image of `findPendingRun`: that one collects untranslated
 * paragraphs and stops at translated ones, this one does the reverse. An
 * untranslated paragraph ends the run rather than being swept in, because
 * re-translation is a replace operation — filling a gap is what the ordinary
 * translate button is for, and mixing the two would make the result message
 * ("12 paragraf diterjemahkan ulang") a lie.
 */
async function findTranslatedRun(
  bookId: string,
  fromIndex: number,
): Promise<RetranslatableParagraph[]> {
  const candidates = await prisma.paragraph.findMany({
    where: { bookId, orderIndex: { gte: fromIndex } },
    orderBy: { orderIndex: "asc" },
    take: CANDIDATE_LIMIT,
    select: {
      id: true,
      orderIndex: true,
      originalText: true,
      charCount: true,
      translatedText: true,
      translatedBy: true,
    },
  });

  const run: RetranslatableParagraph[] = [];

  for (const candidate of candidates) {
    if (candidate.translatedText === null) break;

    run.push({
      id: candidate.id,
      orderIndex: candidate.orderIndex,
      originalText: candidate.originalText,
      charCount: candidate.charCount,
      translatedText: candidate.translatedText,
      translatedBy: candidate.translatedBy,
    });
  }

  return run;
}

interface RetranslatableParagraph extends PendingParagraph {
  translatedText: string;
  translatedBy: string | null;
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
export function groupIntoBatch<T extends { charCount: number }>(
  // Generic so the re-translate path keeps its extra fields
  // (`translatedText`, `translatedBy`) through batching — they are what the
  // undo column is populated from, and widening to `PendingParagraph` here
  // would silently drop them.
  paragraphs: T[],
  maxChars: number,
): T[] {
  const batch: T[] = [];
  let total = 0;

  for (const paragraph of paragraphs) {
    if (batch.length > 0 && total + paragraph.charCount > maxChars) break;

    batch.push(paragraph);
    total += paragraph.charCount;
  }

  return batch;
}

/**
 * Recomputes translation progress from actual paragraph state. Both fields are
 * kept equal for now: the app's practical "last translated index" is the
 * highest translated paragraph anywhere, including explicit jump translations.
 */
async function settleTranslationProgress(
  db: Pick<typeof prisma, "paragraph" | "readingProgress">,
  bookId: string,
  lastTranslatedIndex: number,
  lastTranslatedParagraphIndex: number,
): Promise<{ lastTranslatedIndex: number; lastTranslatedParagraphIndex: number }> {
  const maxTranslated = await db.paragraph.aggregate({
    where: { bookId, translatedText: { not: null } },
    _max: { orderIndex: true },
  });

  const highest = maxTranslated._max.orderIndex ?? -1;

  if (highest !== lastTranslatedIndex || highest !== lastTranslatedParagraphIndex) {
    await db.readingProgress.update({
      where: { bookId },
      data: {
        lastTranslatedIndex: highest,
        lastTranslatedParagraphIndex: highest,
      },
    });
  }

  return { lastTranslatedIndex: highest, lastTranslatedParagraphIndex: highest };
}

type TokenUsageClient = Pick<typeof prisma, "bookTokenUsage">;

async function incrementBookTokenUsage(
  db: TokenUsageClient,
  {
    bookId,
    provider,
    model,
    usage,
  }: {
    bookId: string;
    provider: string;
    model: string;
    usage?: { inputTokens: number; outputTokens: number };
  },
): Promise<void> {
  if (!usage) return;

  const inputTokens = Math.max(0, Math.floor(usage.inputTokens));
  const outputTokens = Math.max(0, Math.floor(usage.outputTokens));
  const totalTokens = inputTokens + outputTokens;

  await db.bookTokenUsage.upsert({
    where: { bookId_provider_model: { bookId, provider, model } },
    create: { bookId, provider, model, inputTokens, outputTokens, totalTokens },
    update: {
      inputTokens: { increment: inputTokens },
      outputTokens: { increment: outputTokens },
      totalTokens: { increment: totalTokens },
    },
  });
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

function resolveMaxChars(requested: number | undefined, providerId: string): number {
  const providerEnvVar = `${providerId.toUpperCase()}_MAX_CHARS`;
  const configured = Number.parseInt(
    process.env[providerEnvVar] ?? process.env.DEFAULT_MAX_CHARS ?? "",
    10,
  );
  const fallback = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_CHARS;
  const value = requested ?? fallback;

  if (!Number.isFinite(value) || value <= 0) {
    throw new TranslationError("`maxChars` must be a positive number.", "provider_error", 400);
  }

  return Math.floor(value);
}
