import { PDFParse } from "pdf-parse";

import type { ParsedParagraph, ParserInput } from "./types";

/**
 * Extracts readable paragraphs from a PDF.
 *
 * PDF text is layout, not structure: headers, page numbers, footers, and
 * hard-wrapped lines often arrive as ordinary text. These heuristics favor
 * novel-style prose over preserving visual layout.
 */

export class PdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfParseError";
  }
}

const MIN_PARAGRAPH_LENGTH = 2;
const PAGE_NOISE_EDGE_LINES = 3;

export async function parse(fileBuffer: ParserInput): Promise<ParsedParagraph[]> {
  const bytes = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer);

  if (!hasPdfHeader(bytes)) {
    throw new PdfParseError("This file does not look like a PDF.");
  }

  const parser = new PDFParse({ data: bytes });

  try {
    const result = await parser.getText();
    const pages = result.pages.map((page) => normalizePageText(page.text));
    const withoutRepeatingNoise = removeRepeatingPageLines(pages);
    const text = withoutRepeatingNoise.join("\n\n");
    const paragraphs = splitIntoParagraphs(text);

    if (paragraphs.length === 0) {
      throw new PdfParseError("No readable text found in this PDF.");
    }

    return toParsedParagraphs(paragraphs);
  } catch (error) {
    if (error instanceof PdfParseError) throw error;

    throw new PdfParseError("This file is not a readable PDF.");
  } finally {
    await parser.destroy();
  }
}

function normalizePageText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isPageMarker(line.trim()))
    .join("\n");
}

/**
 * Removes lines that repeat near page edges, usually running headers/footers.
 * Repeated prose inside the body is left alone.
 */
function removeRepeatingPageLines(pages: string[]): string[] {
  const edgeLineCounts = new Map<string, number>();

  for (const page of pages) {
    const lines = page.split("\n");
    const edgeLines = [...lines.slice(0, PAGE_NOISE_EDGE_LINES), ...lines.slice(-PAGE_NOISE_EDGE_LINES)];
    const seenOnPage = new Set(edgeLines.map(normalizeComparableLine));

    for (const line of seenOnPage) {
      if (line.length > 0) edgeLineCounts.set(line, (edgeLineCounts.get(line) ?? 0) + 1);
    }
  }

  const repeatThreshold = Math.max(3, Math.ceil(pages.length * 0.35));

  return pages.map((page) =>
    page
      .split("\n")
      .filter((line) => {
        const comparable = normalizeComparableLine(line);
        return (edgeLineCounts.get(comparable) ?? 0) < repeatThreshold;
      })
      .join("\n"),
  );
}

function splitIntoParagraphs(text: string): string[] {
  const blocks = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .split(/\n{2,}/)
    .flatMap(splitIndentedParagraphs)
    .flatMap(splitLikelyParagraphs)
    .map(collapseWrappedLines)
    .filter((paragraph) => paragraph.length >= MIN_PARAGRAPH_LENGTH);

  return blocks;
}

function splitIndentedParagraphs(block: string): string[] {
  const lines = block.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (current.length > 0 && /^\s{2,}\S/.test(line)) {
      chunks.push(current.join("\n"));
      current = [];
    }

    current.push(line);
  }

  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks;
}

function splitLikelyParagraphs(block: string): string[] {
  const lines = block.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (looksLikeStandaloneHeading(trimmed)) {
      if (current.length > 0) {
        chunks.push(current.join("\n"));
        current = [];
      }
      chunks.push(trimmed);
      continue;
    }

    current.push(line);

    if (endsParagraph(trimmed)) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }

  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks;
}

function collapseWrappedLines(block: string): string {
  const joined = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    // Repair words broken at line endings: "trans-\nlation" -> "translation".
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalizeQuotationSpacing(joined);
}

function endsParagraph(line: string): boolean {
  return /[.!?…]["')\]]?$/.test(line) && line.length >= 20;
}

function looksLikeStandaloneHeading(line: string): boolean {
  if (line.length > 80) return false;
  if (/[.!?…]["')\]]?$/.test(line)) return false;

  return /^(chapter|prologue|epilogue|book|part)\b/i.test(line) || /^[IVXLCDM]+\.?\s+/.test(line);
}

function isPageMarker(line: string): boolean {
  return (
    /^\d{1,5}$/.test(line) ||
    /^[-–—]\s*\d{1,5}\s*[-–—]$/.test(line) ||
    /^page\s+\d{1,5}(\s+of\s+\d{1,5})?$/i.test(line) ||
    /^\d{1,5}\s+\/\s+\d{1,5}$/.test(line)
  );
}

function normalizeComparableLine(line: string): string {
  return line.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

function toParsedParagraphs(paragraphs: string[]): ParsedParagraph[] {
  let chapterIndex = -1;

  return paragraphs.map((originalText, orderIndex) => {
    if (looksLikeStandaloneHeading(originalText)) chapterIndex += 1;

    return {
      orderIndex,
      originalText,
      charCount: originalText.length,
      chapterIndex: chapterIndex >= 0 ? chapterIndex : undefined,
    };
  });
}

function normalizeQuotationSpacing(text: string): string {
  return text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/(["'“‘])\s+/g, "$1")
    .replace(/\s+(["'”’])/g, "$1");
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = new TextDecoder("ascii").decode(bytes.slice(0, 1024));
  return head.includes("%PDF-");
}
