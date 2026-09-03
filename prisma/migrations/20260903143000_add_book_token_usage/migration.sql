-- Per-book token totals by provider and model.
CREATE TABLE "BookTokenUsage" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookTokenUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookTokenUsage_bookId_idx" ON "BookTokenUsage"("bookId");

CREATE UNIQUE INDEX "BookTokenUsage_bookId_provider_model_key"
    ON "BookTokenUsage"("bookId", "provider", "model");

ALTER TABLE "BookTokenUsage" ADD CONSTRAINT "BookTokenUsage_bookId_fkey"
    FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
