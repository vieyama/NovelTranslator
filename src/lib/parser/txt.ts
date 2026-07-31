import type { ParsedParagraph, ParserInput } from "./types";

/**
 * Splits a plain-text novel into paragraphs (SPEC.md §3.1).
 *
 * Rules:
 * - Paragraphs are separated by a blank line. A "blank" line may contain
 *   whitespace, and any run of consecutive blank lines counts as one separator.
 * - Plain `.txt` novels are usually hard-wrapped at a fixed column, so single
 *   newlines *inside* a paragraph are line wrapping, not structure — they are
 *   collapsed into spaces. Without this, one paragraph would arrive at the
 *   reader (and at the translator) full of arbitrary mid-sentence breaks.
 * - Empty results are dropped, so `orderIndex` stays gapless and sequential.
 */
export function parse(fileBuffer: ParserInput): ParsedParagraph[] {
  const raw = decodeUtf8(fileBuffer);

  const normalized = raw
    // Strip a UTF-8 BOM, which would otherwise become part of paragraph 0.
    .replace(/^﻿/, "")
    // Windows/old-Mac line endings → \n, so one split rule covers every file.
    .replace(/\r\n?/g, "\n");

  return normalized
    .split(/\n[ \t]*\n+/)
    .map((block) => collapseWrappedLines(block))
    .filter((text) => text.length > 0)
    .map((text, index) => ({
      orderIndex: index,
      originalText: text,
      charCount: text.length,
    }));
}

function decodeUtf8(fileBuffer: ParserInput): string {
  const bytes =
    fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer);

  return new TextDecoder("utf-8").decode(bytes);
}

/** Joins hard-wrapped lines within one paragraph and trims the result. */
function collapseWrappedLines(block: string): string {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
}
