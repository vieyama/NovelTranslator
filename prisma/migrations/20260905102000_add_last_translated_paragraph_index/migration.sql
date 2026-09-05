-- Highest translated paragraph anywhere in the book, separate from
-- lastTranslatedIndex, which is the contiguous watermark before the first gap.
ALTER TABLE "ReadingProgress"
ADD COLUMN "lastTranslatedParagraphIndex" INTEGER NOT NULL DEFAULT -1;

UPDATE "ReadingProgress" rp
SET "lastTranslatedParagraphIndex" = COALESCE(translated."maxOrderIndex", -1)
FROM (
    SELECT "bookId", MAX("orderIndex") AS "maxOrderIndex"
    FROM "Paragraph"
    WHERE "translatedText" IS NOT NULL
    GROUP BY "bookId"
) translated
WHERE rp."bookId" = translated."bookId";
