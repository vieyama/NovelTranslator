/**
 * Reader shapes shared by client and server.
 *
 * Kept separate from `reader.ts` for the same reason as `glossary-schema.ts`:
 * that module imports Prisma, so anything a Client Component needs has to live
 * in a module that doesn't.
 */

export interface ReaderParagraph {
  orderIndex: number;
  originalText: string;
  /** `null` = not yet translated. */
  translatedText: string | null;
}

export interface ReaderPage {
  book: {
    id: string;
    title: string;
    author: string | null;
    totalParagraphs: number;
  };
  progress: {
    lastReadIndex: number;
    lastTranslatedIndex: number;
  };
  paragraphs: ReaderParagraph[];
  window: {
    from: number;
    prevFrom: number | null;
    nextFrom: number | null;
  };
  /** First paragraph in the whole book still awaiting translation, if any. */
  firstUntranslatedIndex: number | null;
  translatedCount: number;
}
