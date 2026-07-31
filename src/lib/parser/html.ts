/**
 * Minimal XHTML → paragraph-text helpers, shared by the EPUB parser.
 *
 * Deliberately not a full HTML parser: EPUB content is well-formed XHTML, and
 * all we need is the visible text of block elements in document order.
 */

/** Block tags treated as one paragraph each, in the order they appear. */
const BLOCK_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/**
 * Pulls the text of each block element out of an XHTML document, in order.
 *
 * Falls back to splitting the body on `<div>`/`<br>` when a document uses no
 * block tags at all — some EPUB producers wrap every paragraph in a `<div>`.
 */
export function extractBlockTexts(xhtml: string): string[] {
  const body = stripNonContent(xhtml);

  const pattern = new RegExp(`<(${BLOCK_TAGS.join("|")})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, "gi");

  const blocks: string[] = [];

  for (const match of body.matchAll(pattern)) {
    const text = toPlainText(match[2]);
    if (text.length > 0) blocks.push(text);
  }

  if (blocks.length > 0) return blocks;

  return body
    .split(/<\/div\s*>|<br\s*\/?>/i)
    .map((chunk) => toPlainText(chunk))
    .filter((text) => text.length > 0);
}

/** Strips markup and entities from an XHTML fragment and normalizes whitespace. */
export function toPlainText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " "))
    // Non-breaking spaces are whitespace for reading purposes.
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Removes the document head plus anything non-visible. */
function stripNonContent(xhtml: string): string {
  const withoutInvisible = xhtml
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const body = withoutInvisible.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);

  return body ? body[1] : withoutInvisible;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";

  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
