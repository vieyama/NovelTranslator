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
  - **epub** (built): unzip, read `META-INF/container.xml` → the OPF package,
    then walk the OPF **spine** for reading order. Zip entry order is arbitrary
    and would scramble the book, so it is never used. Each spine document
    becomes one `chapterIndex`. Blocks taken as paragraphs are `<p>`,
    `<h1>`–`<h6>` and `<blockquote>` — headings are included because chapter
    titles are text the reader wants, a small widening of the original "`<p>`
    tags only" rule. Documents using no block tags fall back to splitting on
    `</div>`/`<br>`. Entities are decoded and whitespace collapsed.
  - **pdf**: extract text per page, then heuristic paragraph-splitting (blank
    lines / indentation), needs cleanup for header/footer/page-number noise.
- Save all paragraphs to the DB with a sequential `orderIndex`.
- Create a new `ReadingProgress` record with both indexes at -1.

### 3.2 Translate Batch
- Endpoint: `POST /api/translate`
- Input: `bookId`, `maxChars` (configurable default, e.g. 3000), `fromIndex` (optional)
- Logic:
  1. Fetch paragraphs starting at `lastTranslatedIndex + 1` where
     `translatedText IS NULL` — or, if `fromIndex` was given, starting there
     instead (see "Explicit start index" below).
  2. Group consecutive paragraphs up to `maxChars` without exceeding it (never
     split a paragraph mid-way).
  3. Send to the AI with a translation prompt (system prompt stored in
     config/env, user-customizable — this is the prompt already used manually).
  4. Parse the result, map it back to individual paragraphs (the AI is instructed
     to preserve a paragraph separator, e.g. `\n\n---\n\n`, so it can be split
     back reliably).
  5. Update `translatedText` for each paragraph + `translatedAt`.
  6. Recompute `lastTranslatedIndex` as "last index before the next
     untranslated gap" (not simply "end of this batch" — see below).
- Response: the newly translated paragraphs + the new index.

**Explicit start index (`fromIndex`).** The reader isn't required to translate
strictly in order. `fromIndex` starts the batch at that paragraph instead of
`lastTranslatedIndex + 1`, so the reader can jump translation ahead to wherever
they're reading (e.g. skip a stretch they don't need translated right now).
Paragraphs between the old watermark and `fromIndex` are left untouched, not
lost — `lastTranslatedIndex` simply stops representing "everything before this
index is translated" and starts representing "translated *up to the first
remaining gap*". Concretely, after every batch (explicit `fromIndex` or not),
the watermark is recomputed by scanning forward from its current value for the
first paragraph with `translatedText IS NULL`; the new watermark is the index
right before that gap (or the last paragraph, if there is no gap). This means:
- Translating out of order never desyncs anything the rest of the app reads
  from `lastTranslatedIndex` — it just may not advance yet.
- A later batch that happens to close a gap advances the watermark past the
  whole newly-contiguous stretch in one step, not just past what that batch
  itself translated.
- `firstUntranslatedIndex` / `translatedCount` (used by the reader and library
  progress bars) are plain existence/count queries, not watermark-derived, so
  they're accurate regardless of translation order.

### 3.3 Reader View
- Page `/books/[id]`, renders paragraphs starting from `lastReadIndex + 1` (auto-resume).
- Display toggle: **translated only** / **original only** / **side-by-side**.
- As the user scrolls / clicks "mark read up to here", `lastReadIndex` is updated.
- If the paragraph the user wants to read hasn't been translated yet → a
  "Translate more" button triggers the next batch directly, without navigating away.
- Every untranslated paragraph also has its own "Terjemahkan dari sini" control
  (`TranslateFromHereButton`), which calls `POST /api/translate` with
  `fromIndex` set to that paragraph — the reader-side entry point for §3.2's
  explicit start index, for jumping translation ahead of a gap instead of only
  ever continuing from the watermark.

#### 3.3.1 Pagination

Paragraphs are split into **fixed-size pages** of `READER_PAGE_SIZE` (30)
paragraphs each, aligned to `orderIndex` — page 1 is indexes 0–29, page 2 is
30–59, and so on (`src/lib/reader-schema.ts`). This is the same `orderIndex`
ordering used everywhere else in the app (progress, batching, glossary), so a
page number never disagrees with reading or translation progress — there is no
separate "chapter" or "section" state to fall out of sync with.

- **URL is the source of truth**: the current page lives in `?page=N` on
  `/books/[id]`, not in component state. Opening the reader with no `page`
  resumes on the page containing `lastReadIndex + 1`; an out-of-range value
  clamps to `[1, totalPages]`; a non-numeric value falls back to resume. This
  makes the reader trivially bookmarkable/shareable and removes an entire class
  of state-sync bugs by construction.
- **Numeric pagination** (`src/components/Pagination.tsx`, generic and reusable
  — it knows nothing about paragraphs or books): First (`«`) / Previous (`‹`) /
  windowed page numbers with `…` ellipses / Next (`›`) / Last (`»`). The active
  page has a distinct style and `aria-current="page"`. First/Previous are
  disabled (real `<button disabled>`, not a dead link) on page 1; Next/Last are
  disabled on the last page. Clicking a number jumps straight to that page.
- **Responsive, mobile-first**: two layouts are rendered and toggled with CSS
  breakpoints (`sm:hidden` / `hidden sm:flex`), not a client-side media query —
  the server can't know viewport width ahead of hydration, so a JS-based switch
  would either mismatch on first paint or require a client-only render. Mobile
  shows a compact `‹ 9 [10] 11 ›` (current page ±1, no ellipsis, no First/Last);
  desktop shows the full `« ‹ 1 … 8 9 [10] 11 12 … 35 › »`. All controls are at
  least 44×44px (touch-friendly).
- **Performance**: the page-number list is windowed by construction — its
  length is bounded by the sibling count (≈9 items max), never by `totalPages`.
  A 3000-paragraph, 100-page book still renders the same handful of buttons a
  10-page book does. This is separate from paragraph windowing, which was
  already true since Phase 4 (one page's worth of paragraphs fetched at a
  time, never the whole book).
- **Accessibility**: the control is a `<nav aria-label="Navigasi halaman">`
  wrapping a `<ul>`/`<li>` list. Every First/Previous/Next/Last control has an
  `aria-label`; every page number link has `aria-label="Ke halaman N"`; the
  active page carries `aria-current="page"`; ellipses are
  `aria-hidden="true"` and non-interactive. All controls are plain `<a>` (via
  `next/link`) or `<button>` elements, so Tab/Enter/Space and focus-visible
  styling work without any custom keyboard handling.

### 3.4 Library View
- List of all books, progress bar (`lastTranslatedIndex / totalParagraphs`),
  "Continue reading" / "Continue translating" buttons.
- **Upload form** at the top of the page (`UploadBookForm`): file
  (`.txt`/`.epub`) plus optional title/author, posting to `POST /api/books`.
  Title falls back to the filename when left empty.
- **Delete button** per book (`DeleteBookButton`) calling
  `DELETE /api/books/:id`. Deletion cascades to paragraphs, progress, and
  glossary terms — including all translated text — so the UI confirms with an
  explicit warning before calling it. Irreversible by design; there is no
  archive state.

## 4. API Routes (planned)

| Method | Path                        | Purpose                                   |
|--------|------------------------------|--------------------------------------------|
| POST   | /api/books                  | Upload & parse a new novel                 |
| GET    | /api/books                  | List all books + progress                  |
| GET    | /api/books/:id               | Book detail + paragraphs (paginated)       |
| POST   | /api/translate               | Translate the next batch                   |
| PATCH  | /api/books/:id/progress      | Manually update lastReadIndex              |
| DELETE | /api/books/:id               | Delete a book (built — cascades to paragraphs/progress/glossary) |
| GET    | /api/books/:id/glossary      | List the book's glossary terms             |
| POST   | /api/books/:id/glossary      | Add a glossary term                        |
| PATCH  | /api/books/:id/glossary/:termId | Edit a glossary term                    |
| DELETE | /api/books/:id/glossary/:termId | Delete a glossary term                  |

### 4.1 Server / Client module boundary

Reader and glossary pages are Server Components that query Prisma directly
through `src/lib/`, so not every read needs an API route. That makes one mistake
easy to commit and hard to diagnose:

> **A Client Component must never import a runtime value from a module that
> imports Prisma.** Doing so pulls better-sqlite3's native binding into the
> browser bundle, and the build fails with `Module not found: Can't resolve
> 'fs'` pointing deep inside `node_modules` — nowhere near the actual mistake.
> `tsc` and `eslint` both pass in that state.

Two rules keep it from recurring:

1. Every module touching Prisma, the filesystem, or an API key starts with
   `import "server-only"`. A bad import then fails the build with a message that
   names the file and the reason.
2. Types and constants a Client Component needs live in a **schema module** with
   no Prisma import — `src/lib/glossary-schema.ts`, `src/lib/reader-schema.ts`.
   The server module re-exports them so server code has a single import site.

Note that `import type { … }` from a server module happens to be safe, since
TypeScript erases it — but it reads identically to the unsafe form, so prefer
the schema module in Client Components regardless.

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
// Note: implemented shape (as of Phase 3) differs from earlier draft below —
// this reflects what claudeClient.ts actually uses. geminiClient.ts (Phase 5)
// must match this same shape.
interface TranslationProvider {
  translateBatch(request: { system: string; user: string }): Promise<{
    text: string;
    model: string;
    usage?: unknown;
  }>;
}
```

- `claudeClient.ts` — Anthropic API (implemented in Phase 3, currently the
  working/tested provider)
- `geminiClient.ts` — Google Gemini API (added in Phase 5 as a second provider,
  same interface, selectable via `TRANSLATION_PROVIDER`)

Both use the exact same prompt template from `TRANSLATION_RULES.md` — only the
API call differs — so translation style doesn't depend on which provider handled
a given batch. Provider selection is controlled via config (`.env.local`), with
optional automatic fallback (try primary, fall back to secondary on rate-limit
error) as a later enhancement (Phase 7).

## 7. Configuration

`.env.local`:
```
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
TRANSLATION_PROVIDER=claude   # "claude" | "gemini"
DEFAULT_MAX_CHARS=3000
DATABASE_URL="file:./dev.db"
```

## 8. MVP Scope (Phase 1)

1. Import `.txt` only, for now (easiest to parse).
2. Manually-triggered batch translation ("Translate next batch" button), Gemini
   as the provider used for testing.
3. Simple reader: paragraph list + translated/not-translated status.
4. Auto-resume for both read and translate position.

## 9. Phase 2 (after MVP is working)

- Support `.epub` and `.pdf`.
- Side-by-side bilingual view.
- Translate-ahead in the background (pre-translate a few batches so you never wait).
- Add Claude/Anthropic as a second provider + automatic fallback when the
  primary provider's limit is hit.
- Export translated output to a new `.txt`/`.epub` file.

## 10. Open Questions

- Reader layout preference: paragraph list, or paginated like an e-reader?
- Does the MVP need a full multi-book library, or is a single active book enough
  to start?