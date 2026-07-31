-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "sourceFormat" TEXT NOT NULL,
    "totalParagraphs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Paragraph" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "chapterIndex" INTEGER,
    "originalText" TEXT NOT NULL,
    "translatedText" TEXT,
    "charCount" INTEGER NOT NULL,
    "translatedAt" DATETIME,
    CONSTRAINT "Paragraph_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReadingProgress" (
    "bookId" TEXT NOT NULL PRIMARY KEY,
    "lastTranslatedIndex" INTEGER NOT NULL DEFAULT -1,
    "lastReadIndex" INTEGER NOT NULL DEFAULT -1,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReadingProgress_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GlossaryTerm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "translation" TEXT,
    "category" TEXT,
    "note" TEXT,
    CONSTRAINT "GlossaryTerm_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Paragraph_bookId_orderIndex_idx" ON "Paragraph"("bookId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Paragraph_bookId_orderIndex_key" ON "Paragraph"("bookId", "orderIndex");

-- CreateIndex
CREATE INDEX "GlossaryTerm_bookId_idx" ON "GlossaryTerm"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryTerm_bookId_term_key" ON "GlossaryTerm"("bookId", "term");
