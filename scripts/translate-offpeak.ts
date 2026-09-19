/**
 * Processes enabled DeepSeek off-peak jobs stored by users in Settings.
 * Run from cron; during peak pricing this exits without translating.
 */
import "dotenv/config";

import { setTimeout as sleep } from "node:timers/promises";

import { resolveAiConfigForProvider } from "../src/lib/ai-settings";
import { prisma } from "../src/lib/db";
import { resolveProvider } from "../src/lib/translator/provider";
import { translateNextBatch } from "../src/lib/translator/translateNextBatch";
import { TranslationError } from "../src/lib/translator/types";

const DEEPSEEK_PEAK_WINDOWS_UTC = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 },
] as const;

async function main() {
  const now = new Date();
  if (!isDeepSeekOffPeak(now)) {
    console.log(`[offpeak] ${now.toISOString()} is inside a DeepSeek peak window; nothing run.`);
    return;
  }

  const jobs = await prisma.offPeakTranslationConfig.findMany({
    where: { enabled: true },
    orderBy: { updatedAt: "asc" },
    include: { book: { select: { title: true } } },
  });

  if (jobs.length === 0) {
    console.log("[offpeak] No enabled jobs.");
    return;
  }

  console.log(`[offpeak] Found ${jobs.length} enabled job(s).`);
  for (const job of jobs) await runJob(job);
}

async function runJob(job: {
  id: string;
  userId: string;
  bookId: string;
  maxChars: number;
  maxBatches: number;
  delayMsBetweenBatches: number;
  book: { title: string };
}) {
  let batches = 0;
  let paragraphs = 0;

  try {
    const providerConfig = await resolveAiConfigForProvider(job.userId, "deepseek");
    const provider = resolveProvider(
      { apiKey: providerConfig.apiKey, model: providerConfig.model },
      "deepseek",
    );

    console.log(`[offpeak] Starting "${job.book.title}" (${job.bookId}).`);

    while (batches < job.maxBatches && isDeepSeekOffPeak(new Date())) {
      const result = await translateNextBatch({
        bookId: job.bookId,
        userId: job.userId,
        maxChars: job.maxChars,
        provider,
      });

      if (result.done) {
        await prisma.offPeakTranslationConfig.update({
          where: { id: job.id },
          data: { enabled: false, lastRunAt: new Date(), lastError: null },
        });
        console.log(`[offpeak] "${job.book.title}" has no untranslated data after its latest translated index; job disabled.`);
        return;
      }

      batches += 1;
      paragraphs += result.paragraphs.length;
      console.log(
        `[offpeak] ${job.book.title}: batch ${batches}, ${result.paragraphs.length} paragraph(s).`,
      );

      if (job.delayMsBetweenBatches > 0) await sleep(job.delayMsBetweenBatches);
    }

    await prisma.offPeakTranslationConfig.update({
      where: { id: job.id },
      data: { lastRunAt: new Date(), lastError: null },
    });
    console.log(
      `[offpeak] Finished "${job.book.title}": ${batches} batch(es), ${paragraphs} paragraph(s).`,
    );
  } catch (error) {
    const message = errorMessage(error);
    await prisma.offPeakTranslationConfig
      .update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), lastError: message.slice(0, 1000) },
      })
      .catch((updateError) => console.error("[offpeak] Could not store job error:", updateError));
    console.error(`[offpeak] Failed "${job.book.title}": ${message}`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof TranslationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function isDeepSeekOffPeak(date: Date): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return true;

  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return !DEEPSEEK_PEAK_WINDOWS_UTC.some(
    (window) => hour >= window.startHour && hour < window.endHour,
  );
}

main()
  .catch((error) => {
    console.error("[offpeak] Failed:", errorMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
