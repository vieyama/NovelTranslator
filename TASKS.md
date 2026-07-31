# TASKS.md

Implementation checklist for Claude Code. Work through phases in order — don't
start a later phase until the current one is checked off and manually verified
per the "Definition of Done" in CLAUDE.md.

## Phase 0 — Project Setup

- [x] Initialize Next.js (App Router, TypeScript) project
- [x] Install & configure Tailwind CSS
- [x] Install Prisma, configure SQLite datasource (`DATABASE_URL="file:./dev.db"`)
- [x] Set up `.env.local` (`ANTHROPIC_API_KEY`, `DEFAULT_MAX_CHARS`)
- [x] Add `.gitignore` (`.env.local`, `*.db`, `node_modules`)

Notes:
- Next.js **16.2.12** + React 19 + Tailwind **v4** (PostCSS plugin, no
  `tailwind.config.js` — config is CSS-first in `src/app/globals.css`).
- Prisma **7.9.1**: uses `prisma.config.ts` for the datasource URL (not
  `url = env(...)` in the schema), the `prisma-client` generator with an explicit
  output (`src/generated/prisma`), and requires a **driver adapter** —
  `@prisma/adapter-better-sqlite3` + `better-sqlite3` are installed for Phase 1's
  `src/lib/db.ts`.
- `prisma.config.ts` loads `.env.local` via `dotenv` (the Prisma CLI does not read
  `.env.local` on its own; Next.js does). The default `.env` was deleted so there
  is a single source of config.
- `.env.local.example` added as a committable template.
- `npm audit` reports high-severity advisories in dev-only transitive deps
  (eslint/postcss chains); fixing needs breaking major upgrades, skipped for a
  local single-user app.

## Phase 1 — Data Layer

- [x] Write `prisma/schema.prisma` per SPEC.md §2 (`Book`, `Paragraph`,
      `ReadingProgress`, `GlossaryTerm`)
- [x] Run initial migration
- [x] Create `src/lib/db.ts` (Prisma client singleton)
- [x] Seed script or manual test: insert one dummy book + paragraphs, confirm
      queryable via `prisma studio`

Notes:
- Migration `20260731054813_init`; `dev.db` sits at the project root (same path
  the runtime adapter resolves, since both the CLI and `npm run dev` run from
  there).
- Added `onDelete: Cascade` on `Paragraph`, `ReadingProgress` and `GlossaryTerm`
  so `DELETE /api/books/:id` (SPEC.md §4) doesn't strand rows. Not in the SPEC
  snippet — flag if you'd rather delete explicitly in the route.
- `prisma/seed.ts` (`npm run db:seed`) is idempotent: it deletes the previous
  `[SEED] …` book first, so re-running never duplicates.
- Seed data deliberately leaves paragraphs 2–5 untranslated with
  `lastTranslatedIndex=1`, `lastReadIndex=0`, so Phase 3's "resume from
  `lastTranslatedIndex + 1`" has something real to resume from.
- `postinstall: prisma generate` added, since the generated client lives in
  `src/generated/prisma` (gitignored) and would be missing after a fresh clone.

## Phase 2 — TXT Import (MVP)

- [x] `src/lib/parser/txt.ts`: split raw text into paragraphs (`\n\n`), trim,
      compute `charCount`
- [x] `POST /api/books`: accept file upload, run parser, persist `Book` +
      `Paragraph[]` + initial `ReadingProgress` (both indexes = -1)
- [x] `GET /api/books`: list books with progress summary
- [x] Manual test: upload a real `.txt` novel, confirm paragraph count and order
      look correct in `prisma studio`

Notes:
- Parser handles what real `.txt` novels actually contain: CRLF, UTF-8 BOM, runs
  of blank lines, whitespace-only separator lines, and leading/trailing blank
  lines. All verified with edge-case checks.
- **Hard-wrapped lines are joined.** Plain-text novels wrap at a fixed column, so
  single newlines inside a paragraph are treated as wrapping and collapsed to
  spaces. Without it every paragraph would carry mid-sentence breaks into the
  reader and the translator. Change `collapseWrappedLines` in
  `src/lib/parser/txt.ts` if verse/poetry formatting ever needs preserving.
- `orderIndex` is assigned once, by the parser, and inserted verbatim — the API
  layer never recomputes or infers it.
- Insert runs in one transaction, chunked at 500 rows (SQLite bound-parameter
  limit). Verified with a 3000-paragraph upload: gapless order, no partial book.
- Upload guards: `.txt` only (415), empty file (400), 20 MB cap (413), no
  paragraphs found (422), non-multipart body (400).
- No upload UI yet — Phase 2 is API-only, so the manual test is a `curl` command.
  The library UI arrives in Phase 4.

## Phase 3 — Translation Engine

- [x] `src/lib/translator/prompt.ts`: build prompt from TRANSLATION_RULES.md
      template + injected glossary terms
- [x] `src/lib/translator/claudeClient.ts`: call Anthropic API with batch text
- [x] `src/lib/translator/parseResponse.ts`: split on `---PARAGRAPH---`, validate
      count matches input, throw/return failure if mismatched
- [x] `POST /api/translate`: 
      - fetch next untranslated paragraphs from `lastTranslatedIndex + 1`
      - group up to `maxChars` without splitting a paragraph
      - call translator, parse response
      - on success: update `translatedText`, `translatedAt`, bump
        `lastTranslatedIndex`
      - on failure: return error, do NOT bump the index
- [x] Manual test: translate first batch of the test book, confirm DB updates
      and paragraph count matches

Notes:
- `prompt.ts` reads `TRANSLATION_RULES.md` at runtime and re-reads it whenever the
  file's mtime changes, so prompt edits apply without a restart. It strips the
  `Full Request Template` and `Tuning Log` sections — those are developer notes,
  not model instructions.
- Model `claude-opus-5`, adaptive thinking, effort `medium` (override via
  `TRANSLATION_MODEL` / `TRANSLATION_EFFORT`). Requests are streamed so a long
  batch can't hit the SDK HTTP timeout, and use server-side fallback so a safety
  refusal on dark novel content retries on another model instead of failing.
- **The watermark only advances over a contiguous fully-translated run.**
  `lastTranslatedIndex` is a single number, so translating a non-contiguous set
  would strand the skipped paragraphs behind it permanently.
- Failure paths verified to leave both paragraphs and progress untouched:
  count mismatch, provider exception, refusal, `max_tokens` truncation,
  missing API key.
- `TranslationProvider` deviates slightly from SPEC.md §6:
  `translateBatch(request)` takes `{ system, user }` and returns
  `{ text, model, usage }` rather than `string → string`, so the rules can go in
  the system prompt and token usage is visible. The provider-agnostic shape is
  unchanged — the route never imports Anthropic.

## Phase 4 — Reader UI (MVP)

- [x] `/books` page: library list, progress bar per book, "Continue reading" /
      "Continue translating" buttons
- [x] `/books/[id]` page: paragraph list starting at `lastReadIndex + 1`
- [x] Reader toggle: original / translated / side-by-side
- [x] "Translate next batch" button visible inline when reaching untranslated
      paragraphs
- [x] Update `lastReadIndex` as user reads (scroll-based or explicit "mark read"
      action — pick the simpler one first: explicit button)
- [x] Manual test: close browser, reopen, confirm reader resumes at the correct
      paragraph

Notes:
- Added `PATCH /api/books/:id/progress` (SPEC.md §4) — Phase 4 needs it and it
  wasn't listed separately. The reader pages read the DB directly through
  `src/lib/reader.ts` rather than through a `GET /api/books/:id`, since server
  components can query directly.
- Reader is windowed at 30 paragraphs (`READER_PAGE_SIZE`) with prev/next links;
  a 3000-paragraph novel would be unusable rendered in full. `?from=` overrides
  the resume position without changing it.
- `lastReadIndex` may move backwards — re-reading an earlier chapter is normal.
  Only `lastTranslatedIndex` is monotonic.
- View mode persists in `localStorage` via `useSyncExternalStore`. A
  setState-in-effect is what the lint rule (and React) rejects here; the store
  also keeps server and client HTML identical on hydration.
- Root `/` now redirects to `/books`.
- **Still no upload UI** — the library's empty state points at
  `POST /api/books`. Adding a book is still a `curl`.

## Phase 5 — Glossary (MVP-adjacent, do after Phase 4 works)

- [ ] `GlossaryTerm` CRUD API (`/api/books/:id/glossary`)
- [ ] Simple glossary editor UI on the book detail page
- [ ] Wire glossary terms into the translate prompt (Phase 3 already expects
      this — confirm it's actually being injected, not just a stub)

## Phase 6 — Polish / Phase 2 Features (only after MVP fully works)

- [ ] EPUB parser (`src/lib/parser/epub.ts`)
- [ ] PDF parser (`src/lib/parser/pdf.ts`) with cleanup/preview step
- [ ] Gemini provider (`src/lib/translator/geminiClient.ts`), same prompt
      template, swappable via config/env
- [ ] Provider fallback logic (try Claude, fall back to Gemini on rate limit)
- [ ] Background pre-translation (translate ahead while reading)
- [ ] Export translated book to `.txt`

## Non-Negotiables (recheck before marking any phase done)

- [ ] `orderIndex` is never inferred from text matching, only from stored order
- [ ] A failed translate batch never advances `lastTranslatedIndex`
- [ ] Progress survives a full app restart