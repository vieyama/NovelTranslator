# SPEC — Novel Translator

## 1. Goal

A personal (single-user, local-first) application to:
1. Read English novels (txt/epub/pdf) in a reader UI.
2. Translate text to Indonesian via AI, in batches, with a configurable character
   limit (to fit whatever API/model tier is being used).
3. Automatically track translation progress and reading progress per book, so the
   user never has to manually search for where they left off.

Non-goals (out of scope for now):
- Multi-user / auth
- Publishing / sharing translated output
- Real-time word-by-word streaming translation (translation stays batch-based)

## 2. Data Model

```prisma
model Book {
  id            String   @id @default(cuid())
  title         String
  author        String?
  sourceFormat  String   // "txt" | "epub" | "pdf"
  totalParagraphs Int
  createdAt     DateTime @default(now())

  paragraphs    Paragraph[]
  progress      ReadingProgress?
}

model Paragraph {
  id             String   @id @default(cuid())
  bookId         String
  book           Book     @relation(fields: [bookId], references: [id])
  orderIndex     Int      // absolute order within the book, starting at 0
  chapterIndex   Int?     // optional, for chapter grouping
  originalText   String
  translatedText String?
  charCount      Int
  translatedAt   DateTime?

  @@unique([bookId, orderIndex])
  @@index([bookId, orderIndex])
}

model ReadingProgress {
  bookId              String   @id
  book                Book     @relation(fields: [bookId], references: [id])
  lastTranslatedIndex Int      @default(-1) // last orderIndex that has been translated
  lastReadIndex       Int      @default(-1) // last orderIndex that has been read
  updatedAt           DateTime @updatedAt
}
```

Design notes:
- `orderIndex` is the single source of truth for paragraph order. All "next batch
  to translate" / "resume reading" logic is based on this index, not on
  text-matching.
- `translatedText` is nullable → paragraphs still needing translation are easy to
  query (`WHERE translatedText IS NULL`).
- `lastTranslatedIndex` and `lastReadIndex` are kept separate, since translation
  may run ahead of reading, or the user may re-read earlier parts.

## 3. Features & Flow

### 3.1 Import Novel
- User uploads a file (`.txt`, `.epub`, or `.pdf`).
- The parser splits it into paragraphs:
  - **txt**: split by double newline (`\n\n`), trim whitespace.
  - **epub**: parse HTML per chapter, take `<p>` tags as paragraphs, strip tags.
  - **pdf**: extract text per page, then heuristic paragraph-splitting (blank
    lines / indentation), needs cleanup for header/footer/page-number noise.
- Save all paragraphs to the DB with a sequential `orderIndex`.
- Create a new `ReadingProgress` record with both indexes at -1.

### 3.2 Translate Batch
- Endpoint: `POST /api/translate`
- Input: `bookId`, `maxChars` (configurable default, e.g. 3000)
- Logic:
  1. Fetch paragraphs starting at `lastTranslatedIndex + 1` where
     `translatedText IS NULL`.
  2. Group consecutive paragraphs up to `maxChars` without exceeding it (never
     split a paragraph mid-way).
  3. Send to the AI with a translation prompt (system prompt stored in
     config/env, user-customizable — this is the prompt already used manually).
  4. Parse the result, map it back to individual paragraphs (the AI is instructed
     to preserve a paragraph separator, e.g. `\n\n---\n\n`, so it can be split
     back reliably).
  5. Update `translatedText` for each paragraph + `translatedAt`.
  6. Update `lastTranslatedIndex` to the last successfully translated index.
- Response: the newly translated paragraphs + the new index.

### 3.3 Reader View
- Page `/books/[id]`, renders paragraphs starting from `lastReadIndex + 1` (auto-resume).
- Display toggle: **translated only** / **original only** / **side-by-side**.
- As the user scrolls / clicks "mark read up to here", `lastReadIndex` is updated.
- If the paragraph the user wants to read hasn't been translated yet → a
  "Translate more" button triggers the next batch directly, without navigating away.

### 3.4 Library View
- List of all books, progress bar (`lastTranslatedIndex / totalParagraphs`),
  "Continue reading" / "Continue translating" buttons.

## 4. API Routes (planned)

| Method | Path                        | Purpose                                   |
|--------|------------------------------|--------------------------------------------|
| POST   | /api/books                  | Upload & parse a new novel                 |
| GET    | /api/books                  | List all books + progress                  |
| GET    | /api/books/:id               | Book detail + paragraphs (paginated)       |
| POST   | /api/translate               | Translate the next batch                   |
| PATCH  | /api/books/:id/progress      | Manually update lastReadIndex              |
| DELETE | /api/books/:id               | Delete a book                              |

## 5. Translation Prompt & Glossary

The full default prompt, rules, and separator convention live in
`TRANSLATION_RULES.md` — that file is the source of truth, editable directly by
the user as translation quality gets tuned. `src/lib/translator/prompt.ts` loads
and renders that template rather than hardcoding the prompt in code.

Per-book proper nouns and invented terms (character names, places, magic
systems) are tracked in `GLOSSARY.md` / the `GlossaryTerm` table (see §2 below)
and injected into every translation request, so terminology stays consistent
across batches translated at different times.

## 6. Translation Providers

The app supports multiple AI providers behind a common interface, so translation
isn't blocked if one provider's free-tier limit is hit:

```ts
// src/lib/translator/types.ts
interface TranslationProvider {
  translateBatch(promptText: string): Promise<string>;
}
```

- `claudeClient.ts` — Anthropic API (default/primary)
- `geminiClient.ts` — Google Gemini API (secondary/fallback)

Both use the exact same prompt template from `TRANSLATION_RULES.md` — only the
API call differs — so translation style doesn't depend on which provider handled
a given batch. Provider selection is controlled via config (`.env.local`), with
optional automatic fallback (try primary, fall back to secondary on rate-limit
error) as a Phase 2 feature.

## 7. Configuration

`.env.local`:
```
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
TRANSLATION_PROVIDER=anthropic   # "anthropic" | "gemini"
DEFAULT_MAX_CHARS=3000
DATABASE_URL="file:./dev.db"
```

## 8. MVP Scope (Phase 1)

1. Import `.txt` only, for now (easiest to parse).
2. Manually-triggered batch translation ("Translate next batch" button), Claude
   as the only provider — Gemini support comes in Phase 2.
3. Simple reader: paragraph list + translated/not-translated status.
4. Auto-resume for both read and translate position.

## 9. Phase 2 (after MVP is working)

- Support `.epub` and `.pdf`.
- Side-by-side bilingual view.
- Translate-ahead in the background (pre-translate a few batches so you never wait).
- Add Gemini provider + automatic fallback when the primary provider's limit is hit.
- Export translated output to a new `.txt`/`.epub` file.

## 10. Open Questions

- Reader layout preference: paragraph list, or paginated like an e-reader?
- Does the MVP need a full multi-book library, or is a single active book enough
  to start?