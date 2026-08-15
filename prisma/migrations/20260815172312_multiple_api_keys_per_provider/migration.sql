-- Several API keys per provider (SPEC.md §8.5).
--
-- ORDER MATTERS. Prisma's generated diff put `DROP COLUMN "encryptedApiKey"`
-- first, which would have destroyed every key already saved. Here the column is
-- dropped only after its contents have been copied into the new table, and the
-- whole file runs in one transaction — so if the copy fails, nothing is lost.
--
-- The ciphertext is moved verbatim, never re-encrypted: its AAD is
-- "<userId>:<provider>", which the new table preserves. Re-encrypting would
-- require the master key and a decrypt step, neither of which exists in SQL.

-- 1. The new table.
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- 2. Somewhere to point at the key in use.
ALTER TABLE "AiProviderCredential" ADD COLUMN "activeKeyId" TEXT;

-- 3. Move every existing key across and make it the active one, in a single
--    statement so a key can never land without being pointed at.
WITH moved AS (
    INSERT INTO "ApiKey" ("id", "userId", "provider", "label", "encryptedApiKey", "createdAt")
    SELECT
        gen_random_uuid()::text,
        c."userId",
        c."provider",
        'Kunci utama',
        c."encryptedApiKey",
        CURRENT_TIMESTAMP
    FROM "AiProviderCredential" c
    WHERE c."encryptedApiKey" IS NOT NULL
    RETURNING "id", "userId", "provider"
)
UPDATE "AiProviderCredential" c
SET "activeKeyId" = moved."id"
FROM moved
WHERE c."userId" = moved."userId" AND c."provider" = moved."provider";

-- 4. Only now is the old column redundant.
ALTER TABLE "AiProviderCredential" DROP COLUMN "encryptedApiKey";

-- 5. Constraints and indexes.
CREATE INDEX "ApiKey_userId_provider_idx" ON "ApiKey"("userId", "provider");

CREATE UNIQUE INDEX "AiProviderCredential_activeKeyId_key" ON "AiProviderCredential"("activeKeyId");

ALTER TABLE "AiProviderCredential" ADD CONSTRAINT "AiProviderCredential_activeKeyId_fkey"
    FOREIGN KEY ("activeKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
