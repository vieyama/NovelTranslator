-- lastTranslatedIndex now means the latest translated paragraph position, not
-- a contiguous before-gap watermark. Backfill existing progress rows from
-- persisted Paragraph data so out-of-order translations stop showing -1.
UPDATE "ReadingProgress" rp
SET
  "lastTranslatedIndex" = COALESCE(translated."maxOrderIndex", -1),
  "lastTranslatedParagraphIndex" = COALESCE(translated."maxOrderIndex", -1)
FROM (
    SELECT "bookId", MAX("orderIndex") AS "maxOrderIndex"
    FROM "Paragraph"
    WHERE "translatedText" IS NOT NULL
    GROUP BY "bookId"
) translated
WHERE rp."bookId" = translated."bookId";

UPDATE "ReadingProgress" rp
SET
  "lastTranslatedIndex" = -1,
  "lastTranslatedParagraphIndex" = -1
WHERE NOT EXISTS (
    SELECT 1
    FROM "Paragraph" p
    WHERE p."bookId" = rp."bookId"
      AND p."translatedText" IS NOT NULL
);
