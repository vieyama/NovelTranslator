// Server-only: importing this from a Client Component would pull secrets
// and/or native bindings into the browser bundle. Reads TRANSLATION_RULES.md from disk.
import "server-only";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { PARAGRAPH_SEPARATOR, type TranslationRequest } from "./types";

/**
 * Builds the translation prompt by rendering `TRANSLATION_RULES.md` at runtime.
 *
 * The markdown file is the source of truth for translation style — it is loaded
 * and templated here, never hardcoded in source (CLAUDE.md → Related docs), so
 * the user can tune quality by editing the file alone.
 */

const RULES_FILE = path.join(process.cwd(), "TRANSLATION_RULES.md");

/** Where the translator persona starts — everything above it is doc preamble. */
const RULES_START_HEADING = "## Agent:";

/**
 * Headings that mark the end of the prompt body. `Full Request Template` and
 * `Tuning Log` are notes for the developer, not instructions for the model.
 */
const RULES_END_HEADINGS = ["### Full Request Template", "## Tuning Log"];

export interface GlossaryTermInput {
  term: string;
  translation: string | null;
  category: string | null;
  note: string | null;
}

export interface BuildPromptInput {
  paragraphs: string[];
  glossaryTerms: GlossaryTermInput[];
}

/** Cached rules text, invalidated when the file's mtime changes. */
let rulesCache: { mtimeMs: number; template: string } | null = null;

/**
 * Reads TRANSLATION_RULES.md, re-reading whenever the file changes on disk so
 * prompt edits take effect without restarting the dev server.
 */
export async function loadTranslationRules(): Promise<string> {
  const { mtimeMs } = await stat(RULES_FILE);

  if (rulesCache?.mtimeMs === mtimeMs) {
    return rulesCache.template;
  }

  const raw = await readFile(RULES_FILE, "utf-8");
  const template = extractPromptBody(raw);

  rulesCache = { mtimeMs, template };
  return template;
}

/** Renders the rules + glossary into the system prompt, and the batch into the user turn. */
export async function buildPrompt({
  paragraphs,
  glossaryTerms,
}: BuildPromptInput): Promise<TranslationRequest> {
  const template = await loadTranslationRules();
  const paragraphCount = paragraphs.length;

  const system = template
    .replaceAll("{{glossary_terms}}", formatGlossaryTerms(glossaryTerms))
    .replaceAll("{{paragraph_count}}", String(paragraphCount));

  // Mirrors the "Full Request Template" section of TRANSLATION_RULES.md. The
  // glossary is already in the system prompt, so it isn't repeated here.
  const user = [
    `Text to translate (${paragraphCount} paragraph${paragraphCount === 1 ? "" : "s"}, separate each translated paragraph with a line containing exactly ${PARAGRAPH_SEPARATOR}):`,
    "",
    formatBatchText(paragraphs),
  ].join("\n");

  return { system, user };
}

/** Joins source paragraphs with the same marker the AI must use in its reply. */
export function formatBatchText(paragraphs: string[]): string {
  return paragraphs.join(`\n\n${PARAGRAPH_SEPARATOR}\n\n`);
}

/**
 * Renders the book's glossary as a list the model can apply literally. A null
 * translation means "keep unchanged" (GLOSSARY.md).
 */
export function formatGlossaryTerms(terms: GlossaryTermInput[]): string {
  if (terms.length === 0) {
    return "(No glossary terms recorded for this book yet — follow the naming rules above.)";
  }

  return terms
    .map((entry) => {
      const target = entry.translation?.trim()
        ? entry.translation.trim()
        : "keep unchanged (do not translate)";
      const details = [entry.category, entry.note].filter(Boolean).join(" — ");

      return `- ${entry.term} → ${target}${details ? ` [${details}]` : ""}`;
    })
    .join("\n");
}

/**
 * Slices the prompt body out of the markdown file. Falls back to the whole
 * document if the headings ever move, so a doc edit can't silently produce an
 * empty prompt.
 */
function extractPromptBody(raw: string): string {
  const start = raw.indexOf(RULES_START_HEADING);
  const body = start === -1 ? raw : raw.slice(start);

  const end = RULES_END_HEADINGS.map((heading) => body.indexOf(heading))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];

  return (end === undefined ? body : body.slice(0, end)).trim();
}
