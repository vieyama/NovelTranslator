# SPEC — Novel Translator

## 1. Goal

A personal (single-user, local-first) application to:
1. Read English novels (txt/epub/pdf) in a reader UI.
2. Translate text to Indonesian via AI, in batches, with a configurable character
   limit (to fit whatever API/model tier is being used).
3. Automatically track translation progress and reading progress per book, so the
   user never has to manually search for where they left off.

Non-goals (out of scope for now):
- ~~Multi-user / auth~~ — **superseded**: email+password auth and per-user
  libraries were added later, at explicit user request, once the app was
  deployed to an internet-facing VPS. See §8.
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
- Every read paragraph also has a "mark unread" control next to its "Sudah
  dibaca" label. `lastReadIndex` is a single watermark (like
  `lastTranslatedIndex` in §3.2, but explicitly allowed to move backwards —
  see `setLastReadIndex` in `reader.ts`), so reverting one paragraph reverts
  it *and everything after it* to unread — there's no way to un-read a single
  paragraph in the middle while keeping later ones marked read, by the same
  logic that marking read is "up to here", not "just this one". The action
  reuses the same `PATCH /api/books/:id/progress` endpoint, just with
  `lastReadIndex` set to `orderIndex - 1` instead of `orderIndex`.
- **Two stacked sticky bars** sit above the reader: the
  Perpustakaan/Glosarium nav (`top-0`, fixed `h-11`) and the view-mode toggle
  (`top-11`, so it pins directly beneath). Both are siblings of `<header>`, not
  children — `position: sticky` is confined to its parent's box, so nesting the
  nav inside the header would make it scroll away the moment the header did.
  Their combined 101px is why paragraphs carry `scroll-mt-28` (112px): at the
  previous `scroll-mt-24` (96px) a jumped-to paragraph would land *behind* the
  bars. Measured, not guessed — change one and re-measure the other.
- The header has two "jump to my position" shortcuts: **Ke posisi baca
  terakhir** and **Ke batas terjemahan terakhir**. Each goes to
  `?page=N#p-{index}` — the page holding that paragraph *and* the paragraph
  itself, using the `id="p-{orderIndex}"` anchor `ParagraphBlock` renders.
  Landing at the top of a 30-paragraph page and hunting for the spot defeated
  the point; the page number alone is not the position.
  - The page comes from `pageForIndex(index)`, not `index + 1`, so the button
    lands on the paragraph it names. The two differ only when the target is the
    last paragraph of a page, where `+ 1` would jump a page past it.
  - **Clicking while already on that page is handled in JS, not by the href.**
    The link would then point at the URL already showing, so the browser treats
    it as a no-op and nothing scrolls — precisely the common case of reading on,
    drifting away, and clicking to get back. The handler scrolls the element
    directly instead, honouring `prefers-reduced-motion`.
  - A `-1` watermark (nothing read or translated yet) renders a real
    `<button disabled>` rather than a dead link, per `Pagination.tsx`'s
    convention.
- **"Terjemahkan batch dari #N"** lives in the header, not inline among the
  paragraphs. Inline, it sat beside the first untranslated paragraph *on screen*
  and read as "this is what will be translated" — but the batch always starts at
  the first untranslated paragraph in the whole book, which can be far earlier
  (or later) than anything visible. Out of the paragraph flow there is no
  position to misread, and the label names the real starting index outright.
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
- **Go to page** (`src/components/GoToPage.tsx`, generic like `Pagination`
  beside it): one action to reach any page, since the windowed numbers above
  can only step a few pages at a time — on a 190-page book, getting from page 1
  to page 150 otherwise means many clicks. Navigation is
  `router.push(getHref(page))`, the same App Router client navigation
  `next/link` performs, so it shares the router cache, never reloads the
  document, and still leaves `?page=N` in the URL — reading progress is
  untouched by it, living in the DB keyed by `orderIndex`. Two renderings via
  the same CSS-breakpoint rule as the pagination itself:
  - *mobile*: a native `<select>` of every page ("Halaman 1"…), full width and
    44px tall, so it opens the OS picker;
  - *desktop*: a number input backed by a `<datalist>`, so typing `150` narrows
    to "Halaman 150" and Enter jumps there. A `<select>`'s built-in type-ahead
    can't do this — it matches option text from the start, so "150" would look
    for a page labelled "150…" and never find "Halaman 150".

  The form is `noValidate` on purpose: with `max={totalPages}`, browser
  constraint validation blocks submission of an out-of-range number *before*
  the submit handler runs, so typing 9999 would silently do nothing instead of
  clamping to the last page. `min`/`max` stay for the spinner bounds and
  assistive tech; the clamp in the handler is what actually enforces the range.

  It also restores focus to itself after a jump. App Router navigation resets
  focus to `<body>`, which would strand a keyboard user after every jump; the
  control's elements are not remounted across the navigation, so this restores
  what was lost rather than fighting a fresh render, and it only reclaims focus
  when `<body>` still holds it — never from wherever the reader has since moved
  it deliberately.
- **Performance**: the page-number list is windowed by construction — its
  length is bounded by the sibling count (≈9 items max), never by `totalPages`.
  A 3000-paragraph, 100-page book still renders the same handful of buttons a
  10-page book does. This is separate from paragraph windowing, which was
  already true since Phase 4 (one page's worth of paragraphs fetched at a
  time, never the whole book). `GoToPage` is the deliberate exception: it does
  render one `<option>` per page, because a jump-to-any-page control is
  worthless windowed. That is affordable where a windowed *button* list isn't —
  options are text-only leaf nodes with no handlers, and the popup is the
  browser's own virtualised list, so the per-interactive-element cost the
  windowing avoids simply isn't there (190 pages ≈ 190 options ≈ 7KB of HTML).
- **Accessibility**: the control is a `<nav aria-label="Navigasi halaman">`
  wrapping a `<ul>`/`<li>` list. Every First/Previous/Next/Last control has an
  `aria-label`; every page number link has `aria-label="Ke halaman N"`; the
  active page carries `aria-current="page"`; ellipses are
  `aria-hidden="true"` and non-interactive. All controls are plain `<a>` (via
  `next/link`) or `<button>` elements, so Tab/Enter/Space and focus-visible
  styling work without any custom keyboard handling.

### 3.6 Re-translate & Undo

For when one model's output reads badly and another should be tried. Added
after the multi-provider work, because switching model in Settings was only
half a workflow without a way to redo what the old one produced.

- **`Paragraph.translatedBy`** records `"provider:model"` for every
  translation. Without it there is no way to tell which paragraphs came from
  the model you were unhappy with — which is what makes "redo the bad ones"
  actionable rather than guesswork. Rows predating the column are null and
  render as no attribution rather than a guess. The reader shows it as
  `via <model>` beside each translated paragraph.
- **Re-translation runs a batch**, not a single paragraph, from the paragraph
  whose button was clicked. A paragraph re-translated alone gets *less*
  surrounding context than it had originally, which shifts register and word
  choice away from its neighbours — redoing it to improve quality while
  removing context works against itself. The button says so, rather than
  leaving scope to be inferred from position (§3.3's lesson).
- **`previousTranslatedText` / `previousTranslatedBy` give one level of undo.**
  The premise of the feature is *experimenting* with models, and an experiment
  with no way back is a trap. Undo is per paragraph even though re-translation
  is per batch, so a run where only some paragraphs came out worse can be fixed
  without discarding the ones that improved. Revert **swaps** the two texts
  rather than copying over, so undo is itself undoable.
- **Failure leaves the previous translation exactly where it was.** Nothing is
  written until the reply arrives and `parseTranslationResponse` confirms the
  paragraph count; then it all lands in one transaction. Same contract as
  §3.2, and the reason the old text is never cleared "in preparation".
- **Progress never moves.** Re-translation only replaces non-null text, so it
  cannot open a gap and `lastTranslatedIndex` is meaningless to it.
  `advanceWatermark` is deliberately not called — there is nothing it could
  correctly change, and calling it would invite the belief that it might.
- `findTranslatedRun` is the mirror of `findPendingRun`: it collects translated
  paragraphs and stops at an untranslated one. Filling gaps is the ordinary
  translate button's job; mixing the two would make "12 paragraf diterjemahkan
  ulang" untrue.
- API: `POST /api/translate` with `{ retranslate: true, fromIndex }`, and
  `POST /api/books/:id/paragraphs/:orderIndex/revert`.

Because the glossary is injected through the same prompt builder, this doubles
as the way to refresh translations after correcting glossary terms.

### 3.4 Library View
- List of all books, progress bar (`lastTranslatedIndex / totalParagraphs`),
  "Continue reading" / "Continue translating" buttons.
- **Upload form** at the top of the page (`UploadBookForm`): file
  (`.txt`/`.epub`) plus optional title/author, posting to `POST /api/books`.
  Title falls back to the filename when left empty. Parsing a large novel takes
  a few seconds, so the submit button reports progress via `useFormStatus`
  (see CLAUDE.md — a `useState` flag set inside the form action does not work).
- **Sort control** (`BookSortSelect`), shown once there are at least two books:
  newest/oldest added, title A–Z/Z–A, and most-read/most-translated. The choice
  lives in the URL as `?sort=`, so a sorted library is bookmarkable and survives
  reload and Back; the default (`recent`) is the bare `/books` URL, keeping one
  canonical address. Options are defined once in `books-schema.ts` and shared by
  the server page and the client control. Ranking happens in
  `listBooksWithProgress` on the derived summaries rather than in the SQL, since
  the progress orders key off percentages that aren't columns.
- **Progress percentages use different bases, on purpose.** "Diterjemahkan" is
  the *count* of paragraphs with translated text; "Dibaca" is the
  `lastReadIndex` watermark. Reading is genuinely "read up to here", so a
  watermark describes it exactly. Translation is not: `fromIndex` (§3.2) lets a
  batch run ahead of a gap, and `lastTranslatedIndex` then stops at that gap —
  a book with 20 paragraphs translated but a gap at the start reported **0%**
  next to a "20/2879" taken from the real count. The number and the percentage
  now describe the same thing, and the sort comparators use the same basis as
  the figure they order by.
- **Delete button** per book (`DeleteBookButton`) calling
  `DELETE /api/books/:id`. Deletion cascades to paragraphs, progress, and
  glossary terms — including all translated text — so the UI confirms with an
  explicit warning before calling it. Irreversible by design; there is no
  archive state.

### 3.5 PWA / Offline Caching

Scope is deliberately light: **cache pages already opened**, not a full
offline-first rewrite. There's no client-side data layer (no IndexedDB copy of
paragraphs) and no attempt to let the reader work on a page it has never
visited — this app is still a Server Component reading Prisma/Postgres on every
request; offline support here is a resilience layer on top of that, not a
replacement for it.

- **Installable**: `src/app/manifest.ts` (Next's file convention, auto-linked
  into `<head>` — no manual `<link rel="manifest">`) + `public/icons/icon.svg`.
  `viewport.themeColor` (not `metadata.themeColor` — moved in this Next.js
  version, see `generateViewport` docs) and `metadata.appleWebApp` set the
  status-bar/standalone-mode meta tags.
- **Service worker** (`public/sw.js`, registered by
  `RegisterServiceWorker.tsx`, **production builds only** — a service worker
  caching hashed JS chunks fights `next dev`'s hot reload): every same-origin
  **GET** response (navigations, Next's RSC fetches, static assets) is stored
  network-first. If a later request for that exact URL fails, the last cached
  response is served instead of a browser error page. Mutations
  (POST/PATCH/DELETE — translate, mark-read, delete book) are never
  intercepted; those need a live server by definition.
- **First-visit-ever caveat** (standard service worker behavior, not a bug):
  the page that triggers the *first* SW registration on a device is never
  itself served from that registration — the SW isn't active yet when that
  request goes out. Every page opened after that is cached normally,
  including reopening that same first page later.
- **Unvisited pages while offline** fall back to `public/offline.html`, a
  static "you're offline and this page was never cached" page, rather than the
  browser's default connection-error screen.

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
> imports Prisma.** Doing so pulls in Prisma's `pg` driver, which needs Node's
> raw TCP/TLS sockets — the browser bundle build then fails with
> `Module not found: Can't resolve 'net'` (or `'tls'`), pointing deep inside
> `node_modules` — nowhere near the actual mistake. `tsc` and `eslint` both
> pass in that state.

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

- `claudeClient.ts` — Anthropic API, via `@anthropic-ai/sdk` (streaming +
  adaptive thinking + server-side model fallback).
- `geminiClient.ts` — Google Gemini, via `@google/genai` (typed finish reasons,
  "thought" parts filtered out of the reply).
- `mistralClient.ts` / `openrouterClient.ts` — both speak the OpenAI
  chat-completions shape, so the transport lives once in
  `openAiCompatible.ts` and each file is just configuration (URL, default
  model, headers). Two copies would drift: a fix to the finish-reason handling
  or the defensive content parsing would land in one and not the other.
  - **Plain `fetch`, no SDK.** The vendor SDKs wrap this same POST in `ws`,
    `zod` and OpenTelemetry dependencies. Claude and Gemini earn their SDKs —
    streaming, thinking blocks, typed enums — these do not, and every
    dependency is one more thing that can break a Bun build (§7.1).
  - `temperature: 0.2`, because both default loose enough to paraphrase and the
    reply must return exactly the separator count it was sent.
  - **OpenRouter is a gateway to ~400 models across vendors**, so its curated
    list in `AI_PROVIDERS` is only a starting point — the free-text "Model lain
    (isi manual)" field is the real interface. Its ids are vendor-prefixed
    (`openai/gpt-4o`) and sometimes suffixed (`…:free`), which is why
    `validateModelName` accepts `/`; without that every OpenRouter model is
    rejected at save time. It also sends OpenRouter's optional `HTTP-Referer` /
    `X-Title` attribution pair, omitted when empty rather than sent blank.
  - The curated entries come from OpenRouter's "Top models used by Free Models
    Router", **with every id and price checked against `/api/v1/models`**. Two
    of the five names on that page (`gpt-oss-120b`, `Tencent Hy3`) have no
    `:free` variant at all, so appending the suffix — the obvious reading —
    yields ids that fail at translate time. They are listed at their real,
    cheap-but-paid prices rather than mislabelled as free. Re-check the same way
    before editing this list; the catalogue moves.
  - `openrouter/free` (the Free Models Router itself) is offered but is
    deliberately **never the default**: it picks a free model at random per
    request, so consecutive batches of one book can return in different styles —
    the opposite of what the glossary and `translatedBy` exist to hold steady.
  - OpenRouter reports *upstream* vendor failures as HTTP 200 with an `error`
    object instead of `choices`, so that case is detected explicitly rather
    than surfacing as the much less useful "returned no choices".

All three use the same prompt from `TRANSLATION_RULES.md` — only the API call
differs — so translation style doesn't depend on which provider handled a batch.

**Adding a provider is three edits and no migration**, because `provider` is a
string column and `AiProviderCredential` is keyed by `(userId, provider)`:
a client file, an entry in `AI_PROVIDERS` (`ai-settings-schema.ts`), and one in
`ENV_KEY_BY_PROVIDER` (`ai-settings.ts`). `ProviderName` in `provider.ts` is
**derived from `AI_PROVIDERS`** rather than declared separately — those were
two independent lists, so a provider could be offered in Settings with no
factory behind it and still compile. Now `FACTORIES` fails to typecheck until
it covers the new entry.

Model defaults use `-latest` aliases (`mistral-large-latest`,
`gemini-flash-latest`) rather than dated names, so they don't rot when a new
version ships; Settings' "Model lain (isi manual)" covers anything newer than
the built-in list without a code change.

Provider, model and key are per user (§8.4), falling back to the server env
vars. Automatic fallback between providers on a rate-limit error is still a
later enhancement.

## 7. Configuration

Two env files, read by different things — keep both in sync:

`.env.local` (Next.js dev server, `bun run dev`) / `.env` (Docker Compose, and
Prisma CLI via `prisma.config.ts`'s `dotenv/config`):
```
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
TRANSLATION_PROVIDER=claude   # "claude" | "gemini"
DEFAULT_MAX_CHARS=3000
DATABASE_URL="postgresql://user:password@localhost:5439/novel_translator_db?schema=public"

# Compose-only (docker-compose.yml fails fast if any is missing):
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=
APP_PORT=3007
```

Local dev Postgres runs via `docker compose up -d db`, exposed on host port
5439 (not 5432) to avoid clashing with a system-wide Postgres install, and
bound to `127.0.0.1` only.

**`DATABASE_URL` is host-side only.** It points at `localhost:5439`, which is
correct for `bun run dev`, `prisma studio`, and `prisma migrate dev` — all
running on the host. Containers cannot use it: inside the Compose network the
database is `db:5432`. So `docker-compose.yml` deliberately ignores
`.env`'s `DATABASE_URL` and derives the container-side URL from the
`POSTGRES_*` values instead (`postgresql://$USER:$PASSWORD@db:5432/$DB`). The
URL's host must therefore match the *service name* in `docker-compose.yml` —
renaming that service without updating both `environment:` blocks is what
produces `P1001: Can't reach database server at ...`.

### 7.1 Database: PostgreSQL

Switched from SQLite (`better-sqlite3` driver adapter) to Postgres
(`@prisma/adapter-pg` + `pg`) at the user's explicit request, for both local
dev and the VPS — Prisma's schema/migrations are tied to one provider, so a
split (SQLite for dev, Postgres for prod) would mean maintaining two schema
and migration sets by hand; not worth it here.

- `prisma/schema.prisma`: `datasource db { provider = "postgresql" }`.
- `src/lib/db.ts`: `new PrismaPg({ connectionString: process.env.DATABASE_URL })`
  instead of `PrismaBetterSqlite3`. `pg.Pool` connects lazily on first query —
  unlike `better-sqlite3`, which opens the file eagerly at construction — so a
  merely-syntactically-valid `DATABASE_URL` is enough at build time (see
  Dockerfile below).
- Migrations were regenerated from scratch (`prisma/migrations/` deleted and
  recreated with `prisma migrate dev`) — SQLite and Postgres SQL dialects
  aren't compatible, so the old migration couldn't just be carried over.
- This incidentally resolves every native-binding problem `better-sqlite3` was
  causing (below) — `pg` is pure JS, nothing to compile or trace.

### 7.2 VPS Deployment (Docker + Drone CI)

`Dockerfile` + `docker-compose.yml` + `.drone.yml`, adapted from the user's
existing Drone CI / Nginx Proxy Manager pattern used for other apps (which
uses Postgres + MinIO + SMTP + Google OAuth). Differences from that reference,
and why:

- **Three services: `db`, `migrate`, `app`.** Everything else from the
  reference was dropped — no MinIO, no SMTP, no Google OAuth, no
  `DATA_ENCRYPTION_MASTER_KEY` — this app has no file storage beyond the DB,
  no email flows, and explicitly "No auth/session management needed"
  (CLAUDE.md). Access control for the publicly-reachable VPS instance is basic
  auth at the reverse proxy (Nginx Proxy Manager Access List), entirely
  outside this repo — the app itself is unaware it's behind one. `db`'s host
  port is bound to `127.0.0.1` only (unlike the reference), since nothing
  outside the Docker network needs to reach it directly.
- **The Postgres service is named `db`**, and `migrate`/`app`'s `DATABASE_URL`
  must use `db` as the host (§7 above). The service was originally called
  `postgres`; when it was renamed, the two `DATABASE_URL` values still said
  `@postgres:5432`, and every deploy failed with `P1001: Can't reach database
  server at postgres:5432` — the healthcheck passed (the server was fine), the
  name just didn't resolve. If that error reappears, check the host in the URL
  against the service key before anything else.
- **Runtime is Bun** (`oven/bun:1` builder, `oven/bun:1-slim` runner) — the
  user's default, matching their other apps. It was Node.js (`node:20-slim`)
  for one round: Bun 1.3.x crashed with a fatal NAPI error
  (`Error::New napi_get_last_error_info`) the moment `better-sqlite3`'s native
  binding loaded, verified on both macOS and Linux/arm64 and confirmed a
  genuine Bun bug (its own crash reporter said so), not a config issue. That
  was a native-binding failure, and `pg` is pure JS with no native binding at
  all, so switching the driver removed the cause rather than working around
  it — Bun was re-tested against `pg` and is fine.
- **`migrate` is a one-shot service** (`bunx prisma migrate deploy`), gated on
  `db`'s healthcheck (`depends_on: condition: service_healthy`); `app` in turn
  waits on `migrate` completing successfully — same shape as the reference. It
  runs with `restart: "no"`: the healthcheck already guarantees Postgres is
  accepting connections, so any failure here is a real migration problem, and
  `restart: on-failure` only printed the same error four times over and buried
  it. `.drone.yml` always runs `docker compose logs migrate` after `up` for
  the same reason.
- **Both `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`** are wired as secrets, so
  `TRANSLATION_PROVIDER` can be flipped on the VPS (edit the Drone secret,
  redeploy) without touching code, matching §6's provider-agnostic design.
- **`.drone.yml`'s `write-env` step does not write `DATABASE_URL`**, and there
  is no Drone/Vault secret for it. Compose derives the container-side URL from
  `POSTGRES_*` (§7 above), so a `DATABASE_URL` in `.env` is silently ignored —
  writing one would only create a second, unused source of truth for the host
  name that can drift out of sync with the service name. `POSTGRES_*` are the
  secrets; the URL is assembled from them.
- **`next.config.ts`**: just `output: "standalone"` — no
  `outputFileTracingIncludes` needed (that was specifically working around
  `better-sqlite3`'s prebuilt-binary-via-dynamic-path shape; `pg` has no
  equivalent problem).
- **`DATABASE_URL` is set before `prisma generate` in the `builder` stage** —
  Prisma's config loader resolves the datasource URL before the command runs,
  so the `ARG`/`ENV` pair has to precede it, not just `next build`. This exact
  ordering has broken the build twice: once originally, and again when it
  silently regressed back to `RUN prisma generate` above the `ARG` lines.
- **`deps` installs with `--ignore-scripts`**, so it never runs
  `postinstall: prisma generate` and never needs a datasource URL at all. That
  generate was pure waste there regardless: the generator writes to
  `../src/generated/prisma`, `deps` has no `src/`, and only `node_modules` is
  carried into `builder` — which generates properly once the real sources are
  present. Safe *specifically because* no dependency has an install script now
  that the driver is pure-JS `pg`; this same flag previously caused a real
  outage by skipping `better-sqlite3`'s native-binary step, so recheck it
  before adding any dependency that compiles or downloads a binary.
- **Verified end-to-end locally** before handoff: `docker compose up` against
  a real Postgres container — `migrate` applies cleanly, `app` boots, and a
  full create → read → delete cycle through the real API confirmed the `pg`
  adapter works correctly. This is what caught the real bugs during
  development, in order: `RUN npx prisma generate` running before
  `DATABASE_URL` was set in the Dockerfile; `--ignore-scripts` on `npm ci`
  silently skipping `better-sqlite3`'s own native-binary install step (both
  moot now — Bun + `pg`); and the `postgres` → `db` service rename that left
  `@postgres:5432` in both `DATABASE_URL`s.

## 8. Authentication & AI Settings

Added after the MVP, at explicit user request — this supersedes CLAUDE.md's
original "no auth/session management needed", which described a single-user
app on a local machine, not the internet-facing VPS instance.

### 8.1 Authentication

- **NextAuth v5 (Auth.js), Credentials provider, email + password.**
  `strategy: "jwt"` is forced by that provider: there is no OAuth callback to
  hang a database session off. The user id is copied into the token so every
  request can scope queries without re-reading the user row.
- **No public sign-up.** Accounts come from `bun run user:create` only. The
  instance is reachable from the internet, and an open registration form on it
  would let anyone create an account.
- **Passwords are scrypt** (`src/lib/password.ts`), from `node:crypto` rather
  than bcrypt/argon2 — both of those ship native bindings, and this project has
  already lost time to one (§7.1). Parameters are stored alongside each hash, so
  raising the cost later doesn't invalidate existing passwords.
- **Login does not reveal whether an account exists.** A missing user is still
  verified against a dummy hash so the timing matches, and the error text is the
  same either way.
- **`src/proxy.ts`, not `middleware.ts`** — Next 16 renamed the convention and
  Proxy now defaults to the Node.js runtime. It only checks that a session
  cookie is *present*, and covers page routes; `/api/*` is excluded so an
  expired session gets a JSON 401 rather than a 307 into an HTML login page that
  `fetch` cannot parse. **It is a redirect, not the security boundary** — real
  verification is `requireUser` / `requireApiUser` (`src/lib/session.ts`), which
  every protected page and route calls. A new API route is not protected by the
  proxy and must call one of them.

### 8.1.1 Creating accounts

Two entry points, both going through `createUser` in `src/lib/users.ts` so the
DEK wrapping and the book-claiming rule can't drift apart:

- **`bun run user:create [email] [name]`** — interactive, prompts for the
  password without echoing it.
- **`scripts/bootstrap-user.ts`** — reads `BOOTSTRAP_USER_EMAIL` /
  `BOOTSTRAP_USER_PASSWORD` / `BOOTSTRAP_USER_NAME`, and is run by the `migrate`
  service immediately after `prisma migrate deploy` on every deploy. This is
  what makes the first production deploy work without an SSH session.

**Neither can run in the production image.** `runner` contains only
`.next/standalone`, `public`, and `.next/static` — no `scripts/`, no `tsx`, no
full `node_modules`. The `migrate` service is built from the `builder` stage,
which is the only image that still has them, so it carries `APP_ENCRYPTION_KEY`
too (it needs to wrap the new user's DEK). To add an account later:

```bash
docker compose run --rm migrate \
  bun --conditions=react-server scripts/create-user.ts you@example.com
```

**Bootstrap never modifies an existing account.** If the email is already
present it is left alone, password included. Re-applying the password on every
deploy would silently undo a password change and turn a stale Vault entry into a
permanent way in. The consequence is that the bootstrap password is effectively
permanent until a change-password path exists.

Setting only one of the two variables is treated as a misconfiguration and
reported, not silently skipped — otherwise a typo would produce an instance
nobody can log into, with nothing in the deploy log to say why.

### 8.2 Per-user data

`Book.userId` scopes the library; paragraphs, progress, and glossary terms
follow their book. Every entry point taking a book id goes through
`assertBookOwned` (`src/lib/ownership.ts`) or a `findFirst({ id, userId })`.

- **Someone else's book is a 404, never a 403.** A 403 would confirm the id
  exists, which is exactly what a probe is looking for.
- `userId` is **nullable** only because books predate authentication — the
  migration had to run against a database that already had rows. The first
  account created claims every unowned book automatically; after that they stay
  unowned and invisible, on the grounds that a second user must not inherit
  someone else's library.
- **This is why the first deploy would otherwise look like data loss.** The
  migration is purely additive (`ADD COLUMN "userId" TEXT`, plus new tables —
  verified against a populated copy of the schema: book, paragraphs, glossary
  and both progress watermarks all survived). But every query filters by owner,
  so until an account exists the library renders empty. §8.1.1's bootstrap step
  closes that window automatically.

### 8.3 Encrypted API keys

Users store their own provider API key, so it has to be encrypted at rest.
Envelope encryption, AES-256-GCM throughout (`src/lib/crypto.ts`):

```
APP_ENCRYPTION_KEY (env, never in the DB)
  └─ wraps ─> User.encryptedDek          (AAD = user id)
                └─ decrypts to ─> DEK    (per user, memory only)
                                    └─ encrypts ─> AiProviderCredential.encryptedApiKey
                                                   (AAD = "<userId>:<provider>")
```

**Why the master key is in the environment and not the user table.** The
original design put the key in the database, wrapped with something derived
from the username. That protects nothing: username is not a secret and lives in
the same table, so anyone holding a database dump holds every ingredient needed
to unwrap it. The root of trust has to sit outside the data it protects — with
it in `.env`, a stolen dump is inert.

**The user id is still mixed in, as AAD rather than as key material.** GCM
authenticates associated data without encrypting it and refuses to decrypt when
it doesn't match, which binds each ciphertext to its owner: moving a wrapped DEK
or an encrypted key into another user's row makes it fail to decrypt instead of
working. That is the property the original "combine with the username" idea was
reaching for, implemented so it actually holds.

Consequences worth knowing:

- **Losing `APP_ENCRYPTION_KEY` makes every stored API key unreadable.** Not
  recoverable by design. Users re-enter theirs in Settings; nothing else is lost.
- Ciphertexts are `v1.<iv>.<tag>.<ciphertext>` (base64url). The version prefix
  exists so key rotation doesn't have to guess at the format of old rows.
- The plaintext key **never goes back to the browser** — the settings page shows
  only a mask (`AIza…3456`) derived by decrypting server-side.
- Unwrapped DEKs are never cached across requests. Caching one would keep a
  user's data key alive in a process serving every other user.

### 8.4 Settings resolution order

Every value is **user setting → server env var → built-in default**, so an
install that has never opened Settings behaves exactly as it did before this
feature, and a user with no key of their own rides on the server's.

`AiProviderCredential` is one row per (user, provider), so switching provider in
Settings doesn't discard the model and key configured for the other one.

**No provider's API key is required in the environment.** All three are
`${..:-}` in `docker-compose.yml`, deliberately alike: the per-user key is the
real one, and failing a deploy over an unused server-wide secret would be
backwards. A provider with no key anywhere fails at translate time with
"Belum ada API key untuk X. Tambahkan di halaman Pengaturan." — which is where
the fix is.

**The provider clients no longer cache their SDK client at module scope.** That
was safe while the key came from one env var; with per-user keys it would pin
the first user's key into the module and bill every later request to them.

## 9. MVP Scope (Phase 1)

1. Import `.txt` only, for now (easiest to parse).
2. Manually-triggered batch translation ("Translate next batch" button), Gemini
   as the provider used for testing.
3. Simple reader: paragraph list + translated/not-translated status.
4. Auto-resume for both read and translate position.

## 10. Phase 2 (after MVP is working)

- Support `.epub` and `.pdf`.
- Side-by-side bilingual view.
- Translate-ahead in the background (pre-translate a few batches so you never wait).
- Add Claude/Anthropic as a second provider + automatic fallback when the
  primary provider's limit is hit.
- Export translated output to a new `.txt`/`.epub` file.

## 11. Open Questions

- Reader layout preference: paragraph list, or paginated like an e-reader?
- Does the MVP need a full multi-book library, or is a single active book enough
  to start?