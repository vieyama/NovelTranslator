/**
 * Shared shape for every parser in this directory. Each format module
 * (`txt.ts`, later `epub.ts`, `pdf.ts`) exports `parse(fileBuffer)` returning
 * these, in reading order (CLAUDE.md → Code Structure).
 *
 * `orderIndex` is assigned by the parser and is the single source of truth for
 * position — nothing downstream may re-derive order by matching text.
 */
export interface ParsedParagraph {
  orderIndex: number;
  originalText: string;
  charCount: number;
  chapterIndex?: number;
}

export type ParserInput = ArrayBuffer | Uint8Array;
