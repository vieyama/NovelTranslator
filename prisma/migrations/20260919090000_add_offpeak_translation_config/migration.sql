CREATE TABLE "OffPeakTranslationConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxChars" INTEGER NOT NULL DEFAULT 3000,
    "maxBatches" INTEGER NOT NULL DEFAULT 50,
    "delayMsBetweenBatches" INTEGER NOT NULL DEFAULT 1000,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OffPeakTranslationConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OffPeakTranslationConfig_userId_key"
    ON "OffPeakTranslationConfig"("userId");
CREATE INDEX "OffPeakTranslationConfig_enabled_idx"
    ON "OffPeakTranslationConfig"("enabled");
CREATE INDEX "OffPeakTranslationConfig_bookId_idx"
    ON "OffPeakTranslationConfig"("bookId");

ALTER TABLE "OffPeakTranslationConfig" ADD CONSTRAINT "OffPeakTranslationConfig_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OffPeakTranslationConfig" ADD CONSTRAINT "OffPeakTranslationConfig_bookId_fkey"
    FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
