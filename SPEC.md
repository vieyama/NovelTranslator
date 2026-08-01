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
- Every read paragraph also has a "mark unread" control next to its "Sudah
  dibaca" label. `lastReadIndex` is a single watermark (like
  `lastTranslatedIndex` in §3.2, but explicitly allowed to move backwards —
  see `setLastReadIndex` in `reader.ts`), so reverting one paragraph reverts
  it *and everything after it* to unread — there's no way to un-read a single
  paragraph in the middle while keeping later ones marked read, by the same
  logic that marking read is "up to here", not "just this one". The action
  reuses the same `PATCH /api/books/:id/progress` endpoint, just with
  `lastReadIndex` set to `orderIndex - 1` instead of `orderIndex`.
- The header has two "jump to my position" shortcuts: **Ke posisi baca
  terakhir** (→ the page containing `lastReadIndex + 1`) and **Ke batas
  terjemahan terakhir** (→ the page containing `lastTranslatedIndex + 1`).
  Plain `?page=N` navigation via `pageForIndex` — no fetch, no client state.
  Since browsing via numeric pagination can leave the reader far from either
  watermark, these are the fast way back. Whichever one matches the page
  already being viewed renders as a real disabled `<button>` rather than a
  no-op link, the same convention as `Pagination.tsx`'s disabled ends.
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