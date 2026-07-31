-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "sourceFormat" TEXT NOT NULL,
    "totalParagraphs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paragraph" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "chapterIndex" INTEGER,
    "originalText" TEXT NOT NULL,
    "translatedText" TEXT,
    "charCount" INTEGER NOT NULL,
    "translatedAt" TIMESTAMP(3),

    CONSTRAINT "Paragraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadingProgress" (
    "bookId" TEXT NOT NULL,
    "lastTranslatedIndex" INTEGER NOT NULL DEFAULT -1,
    "lastReadIndex" INTEGER NOT NULL DEFAULT -1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReadingProgress_pkey" PRIMARY KEY ("bookId")
);

-- CreateTable
CREATE TABLE "GlossaryTerm" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "translation" TEXT,
    "category" TEXT,
    "note" TEXT,

    CONSTRAINT "GlossaryTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Paragraph_bookId_orderIndex_idx" ON "Paragraph"("bookId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Paragraph_bookId_orderIndex_key" ON "Paragraph"("bookId", "orderIndex");

-- CreateIndex
CREATE INDEX "GlossaryTerm_bookId_idx" ON "GlossaryTerm"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryTerm_bookId_term_key" ON "GlossaryTerm"("bookId", "term");

-- AddForeignKey
ALTER TABLE "Paragraph" ADD CONSTRAINT "Paragraph_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadingProgress" ADD CONSTRAINT "ReadingProgress_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlossaryTerm" ADD CONSTRAINT "GlossaryTerm_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
