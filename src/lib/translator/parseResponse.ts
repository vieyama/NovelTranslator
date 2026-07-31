import { PARAGRAPH_SEPARATOR } from "./types";

/**
 * Splits the AI's reply back into individual paragraphs.
 *
 * The count returned MUST equal the count sent. A mismatch means the mapping
 * from translation → `orderIndex` is no longer trustworthy, so the caller must
 * fail the batch rather than write shifted data (CLAUDE.md → "Parsing the AI
 * response").
 */

export type ParseResult =
  | { ok: true; paragraphs: string[] }
  | { ok: false; error: string; expected: number; received: number };

/** Matches the separator on a line of its own, tolerating stray whitespace. */
const SEPARATOR_LINE = new RegExp(`^[ \\t]*${PARAGRAPH_SEPARATOR}[ \\t]*$`, "m");

export function parseTranslationResponse(raw: string, expected: number): ParseResult {
  const cleaned = stripCodeFence(raw.replace(/\r\n?/g, "\n")).trim();

  if (cleaned.length === 0) {
    return { ok: false, error: "The model returned an empty response.", expected, received: 0 };
  }

  const segments = cleaned
    .split(new RegExp(SEPARATOR_LINE.source, "m"))
    .map((segment) => segment.trim());

  // A separator emitted before the first or after the last paragraph is a
  // harmless formatting artifact — drop those, but never an internal blank.
  if (segments.length > 1 && segments[0] === "") segments.shift();
  if (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();

  if (segments.length !== expected) {
    return {
      ok: false,
      error: `Expected ${expected} translated paragraph${expected === 1 ? "" : "s"} but the model returned ${segments.length}. The batch was not saved.`,
      expected,
      received: segments.length,
    };
  }

  const blankIndex = segments.findIndex((segment) => segment.length === 0);
  if (blankIndex !== -1) {
    return {
      ok: false,
      error: `Translated paragraph ${blankIndex + 1} of ${expected} came back empty. The batch was not saved.`,
      expected,
      received: segments.length,
    };
  }

  return { ok: true, paragraphs: segments };
}

/** Unwraps a whole-response ``` fence, which some models add around long output. */
function stripCodeFence(text: string): string {
  const fenced = text.trim().match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : text;
}
