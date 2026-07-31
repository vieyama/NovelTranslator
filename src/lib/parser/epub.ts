import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

import { extractBlockTexts } from "./html";
import type { ParsedParagraph, ParserInput } from "./types";

/**
 * Parses an EPUB into paragraphs (SPEC.md §3.1).
 *
 * An EPUB is a ZIP holding an OPF package file. Reading order comes from the
 * OPF **spine**, never from the zip's own entry order — which is arbitrary and
 * would scramble the book. Each spine document becomes one `chapterIndex`.
 *
 * Same signature as `txt.ts`: `parse(fileBuffer) => ParsedParagraph[]`.
 */

export class EpubParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubParseError";
  }
}

/** XHTML media types that can hold readable text. */
const CONTENT_TYPES = ["application/xhtml+xml", "text/html"];

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // Keeps single-item manifests/spines from collapsing into a bare object.
  isArray: (name) => ["item", "itemref", "rootfile"].includes(name),
});

export function parse(fileBuffer: ParserInput): ParsedParagraph[] {
  const files = unzip(fileBuffer);
  const opfPath = findOpfPath(files);
  const opfDir = dirnameOf(opfPath);

  const opf = xml.parse(readText(files, opfPath));
  const pkg = opf?.package;

  if (!pkg) {
    throw new EpubParseError("The OPF package file is missing its <package> root.");
  }

  const manifest = new Map<string, { href: string; mediaType: string }>();

  for (const item of pkg.manifest?.item ?? []) {
    const id = item?.["@id"];
    const href = item?.["@href"];
    if (typeof id === "string" && typeof href === "string") {
      manifest.set(id, { href, mediaType: String(item["@media-type"] ?? "") });
    }
  }

  const spine = pkg.spine?.itemref ?? [];

  if (spine.length === 0) {
    throw new EpubParseError("The EPUB spine is empty, so reading order is unknown.");
  }

  const paragraphs: ParsedParagraph[] = [];
  let chapterIndex = 0;

  for (const itemref of spine) {
    const entry = manifest.get(String(itemref?.["@idref"] ?? ""));

    if (!entry || !CONTENT_TYPES.includes(entry.mediaType)) continue;

    const path = resolvePath(opfDir, entry.href);
    const raw = files[path];

    // A spine entry pointing at a missing file is a malformed book, not a
    // reason to abandon the rest of it.
    if (!raw) continue;

    const texts = extractBlockTexts(decodeUtf8(raw));

    if (texts.length === 0) continue;

    for (const text of texts) {
      paragraphs.push({
        orderIndex: paragraphs.length,
        chapterIndex,
        originalText: text,
        charCount: text.length,
      });
    }

    chapterIndex += 1;
  }

  if (paragraphs.length === 0) {
    throw new EpubParseError("No readable text found in this EPUB.");
  }

  return paragraphs;
}

function unzip(fileBuffer: ParserInput): Record<string, Uint8Array> {
  const bytes = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer);

  try {
    return unzipSync(bytes);
  } catch {
    throw new EpubParseError("This file is not a readable EPUB (ZIP) archive.");
  }
}

/** `META-INF/container.xml` names the OPF; falling back to a scan is safer than guessing. */
function findOpfPath(files: Record<string, Uint8Array>): string {
  const container = files["META-INF/container.xml"];

  if (container) {
    const parsed = xml.parse(decodeUtf8(container));
    const fullPath = parsed?.container?.rootfiles?.rootfile?.[0]?.["@full-path"];

    if (typeof fullPath === "string" && files[fullPath]) return fullPath;
  }

  const found = Object.keys(files).find((name) => name.toLowerCase().endsWith(".opf"));

  if (!found) {
    throw new EpubParseError("No OPF package file found — this doesn't look like an EPUB.");
  }

  return found;
}

function readText(files: Record<string, Uint8Array>, path: string): string {
  const raw = files[path];

  if (!raw) {
    throw new EpubParseError(`EPUB is missing "${path}".`);
  }

  return decodeUtf8(raw);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Resolves a manifest href against the OPF's own directory, handling `../`
 * segments and percent-encoded filenames.
 */
function resolvePath(baseDir: string, href: string): string {
  const withoutFragment = decodeHref(href.split("#")[0]);
  const segments = (baseDir ? `${baseDir}/${withoutFragment}` : withoutFragment).split("/");
  const stack: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }

  return stack.join("/");
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}
