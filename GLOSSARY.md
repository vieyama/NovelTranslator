# GLOSSARY.md

Terms that must stay consistent across the entire book's translation — character
names, invented places, magic systems, titles, recurring phrases. Without this,
an AI translating in isolated batches can render the same name or term
differently from one batch to the next.

## Why This Matters

Each translation batch is sent to the AI with limited context (only the current
paragraph group, not the whole book so far). Without a fixed reference, "Lord
Ashveil" might become "Tuan Ashveil" in batch 3 and "Lord Ashveil" again in
batch 12. This file is injected into every translation request so the AI has a
consistent source of truth regardless of batch order.

## Structure (per book)

Each book should have its own glossary, stored either as:
- A `Glossary` table in the DB (`bookId`, `term`, `translation`, `note`), editable
  from the UI, **or**
- A per-book section in this file during early development, before the DB-backed
  version exists.

Recommended DB shape (add to DATABASE section of SPEC.md if formalized):

```prisma
model GlossaryTerm {
  id          String  @id @default(cuid())
  bookId      String
  book        Book    @relation(fields: [bookId], references: [id])
  term        String       // original English term
  translation String?      // Indonesian form, or null = "keep unchanged"
  category    String?      // "character" | "place" | "term" | "title" | etc.
  note        String?

  @@unique([bookId, term])
}
```

## Example (template — replace per book)

| Term            | Translation      | Category  | Note                                    |
|-----------------|-------------------|-----------|-------------------------------------------|
| Arthur          | Arthur            | character | Names stay as-is per translation rules    |
| Black Forest    | Black Forest      | place     | Place names stay as-is                    |
| Fireball        | Fireball          | skill     | Unique skill name, kept in English        |
| Dragon Slayer   | Dragon Slayer     | item      | Unique item, kept unchanged               |
| potion          | ramuan            | item      | Generic item — translated per item rules  |
| -sama           | -sama             | honorific | Honorifics kept, used in natural Indonesian phrasing |

Categories should mirror the naming rules in `TRANSLATION_RULES.md`
(character/place/organization/race names untranslated; unique skills/items
untranslated; generic items translated; honorifics kept).

## Workflow

1. While reading/translating, whenever a recurring proper noun or invented term
   first appears, add it here (or via the UI glossary editor) before continuing.
2. The translate batch endpoint fetches the book's glossary and injects it into
   the prompt (see TRANSLATION_RULES.md → `{{glossary_terms}}`).
3. If a term's translation is changed later, previously translated paragraphs are
   **not** auto-updated — that's a manual re-translate action if needed, to avoid
   silently rewriting large portions of already-read text.