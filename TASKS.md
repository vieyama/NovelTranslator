# TASKS.md

Implementation checklist for Claude Code. Work through phases in order — don't
start a later phase until the current one is checked off and manually verified
per the "Definition of Done" in CLAUDE.md.

## Phase 0 — Project Setup ✅

> **Superseded (Phase 7): datasource is now PostgreSQL, not SQLite.** Every
> `better-sqlite3` / `file:./dev.db` mention below describes the DB engine as
> it was from Phase 0 through most of Phase 7 — see the "Switch database to
> PostgreSQL" entry near the end of Phase 7 for the change and why. Left
> in place rather than rewritten, since this file is a sequential build log.

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
- `prisma.config.ts` loads env vars via `dotenv` (the Prisma CLI does not read
  `.env.local` on its own; Next.js does). **Superseded (deployment work): it is
  now plain `import 'dotenv/config'`, which reads `.env`, not `.env.local`** —
  `.env` is also what `docker compose` reads, so the two files now exist side
  by side with the same contents rather than one being deleted. SPEC.md §7.
- `.env.local.example` added as a committable template for both.
- `npm audit` reports high-severity advisories in dev-only transitive deps
  (eslint/postcss chains); fixing needs breaking major upgrades, skipped for a
  local single-user app.

## Phase 1 — Data Layer ✅

- [x] Write `prisma/schema.prisma` per SPEC.md §2 (`Book`, `Paragraph`,
      `ReadingProgress`, `GlossaryTerm`)
- [x] Run initial migration
- [x] Create `src/lib/db.ts` (Prisma client singleton)
- [x] Seed script or manual test: insert one dummy book + paragraphs, confirm
      queryable via `prisma studio`

Notes:
- Migration `20260731054813_init`; `dev.db` sits at the project root (same path
  the runtime adapter resolves, since both the CLI and `bun run dev` run from
  there).
- Added `onDelete: Cascade` on `Paragraph`, `ReadingProgress` and `GlossaryTerm`
  so `DELETE /api/books/:id` (SPEC.md §4) doesn't strand rows. Not in the SPEC
  snippet — flag if you'd rather delete explicitly in the route.
- `prisma/seed.ts` (`bun run db:seed`) is idempotent: it deletes the previous
  `[SEED] …` book first, so re-running never duplicates.
- Seed data deliberately leaves paragraphs 2–5 untranslated with
  `lastTranslatedIndex=1`, `lastReadIndex=0`, so Phase 3's "resume from
  `lastTranslatedIndex + 1`" has something real to resume from.
- `postinstall: prisma generate` added, since the generated client lives in
  `src/generated/prisma` (gitignored) and would be missing after a fresh clone.

## Phase 2 — TXT Import (MVP) ✅

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
  limit — superseded by Phase 7's Postgres switch, whose parameter limit is
  much higher, but the chunking is harmless under Postgres too, so the code
  wasn't changed). Verified with a 3000-paragraph upload: gapless order, no
  partial book.
- Upload guards: `.txt` only (415), empty file (400), 20 MB cap (413), no
  paragraphs found (422), non-multipart body (400).
- No upload UI yet — Phase 2 is API-only, so the manual test is a `curl` command.
  The library UI arrives in Phase 4.

## Phase 3 — Translation Engine ✅

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
  unchanged — the route never imports Anthropic directly.
  **Important for Phase 5 below: `geminiClient.ts` must implement this same
  `{ system, user } → { text, model, usage }` shape, not the older `string →
  string` shape from SPEC.md §6.**

## Phase 4 — Reader UI (MVP) ✅

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
  a 3000-paragraph novel would be unusable rendered in full. **Superseded below**
  by the numeric pagination upgrade — navigation is now `?page=N` (1-based page
  number), not `?from=` (a raw `orderIndex`); see the pagination entry further
  down this phase and SPEC.md §3.3.1.
- `lastReadIndex` may move backwards — re-reading an earlier chapter is normal.
  Only `lastTranslatedIndex` is monotonic.
- View mode persists in `localStorage` via `useSyncExternalStore`. A
  setState-in-effect is what the lint rule (and React) rejects here; the store
  also keeps server and client HTML identical on hydration.
- Root `/` now redirects to `/books`.
- **Still no upload UI** — the library's empty state points at
  `POST /api/books`. Adding a book is still a `curl`.

## Phase 5 — Add Gemini Provider ✅

Claude is already working and tested (Phase 3). This phase adds Gemini as a
**second** provider, selectable via env var, without touching the translate
route's contract.

- [x] Add `GEMINI_API_KEY` and `TRANSLATION_PROVIDER` (`"claude"` | `"gemini"`)
      to `.env.local` and `.env.local.example`
- [x] `src/lib/translator/geminiClient.ts`: implement the **same interface as
      `claudeClient.ts`** — `translateBatch({ system, user }) → { text, model,
      usage }` (see Phase 3 notes above; do not use the older SPEC.md §6
      `string → string` shape, it's outdated)
- [x] Provider selection in `POST /api/translate`: read `TRANSLATION_PROVIDER`
      from env, instantiate the matching client. The route logic (fetch
      paragraphs, batch, parse response, update DB, watermark rules) stays
      identical regardless of provider — only the client swaps.
- [x] Confirm `parseResponse.ts` and the `---PARAGRAPH---` validation apply
      unchanged to Gemini's output (Gemini may format slightly differently —
      test this explicitly, don't assume).
- [x] Confirm the glossary + `TRANSLATION_RULES.md` prompt template is shared
      between both clients (same system prompt content, not two copies).
- [x] Manual test: set `TRANSLATION_PROVIDER=gemini`, translate a batch on the
      test book, confirm same DB update behavior as the Claude test in Phase 3
      (paragraph count matches, watermark advances correctly, failures don't
      bump the index).
- [~] Manual test: switch back to `TRANSLATION_PROVIDER=claude`, confirm it
      still works (no regression from adding Gemini). — **Selection path
      verified, live call NOT run: `ANTHROPIC_API_KEY` is still empty.**

Notes:
- `src/lib/translator/provider.ts` is the only place that knows which providers
  exist. `POST /api/translate` calls `resolveProvider()` and passes the result
  into the unchanged `translateNextBatch`, so batching, `parseResponse`, and the
  watermark rules are shared verbatim.
- **Prompt sharing verified by assertion, not by eye**: the `systemInstruction`
  Gemini receives is byte-identical to what `buildPrompt()` produces, glossary
  included. There is no second copy of the rules.
- `TRANSLATION_PROVIDER` accepts `claude`/`anthropic` and `gemini`/`google`,
  case-insensitively. An unknown value is a 500 with a clear message rather than
  a silent fallback.
- **`claudeClient`'s `id` changed from `"anthropic"` to `"claude"`** so the
  `provider` field in the API response matches the config value.
- **Default Gemini model is `gemini-flash-latest`, not Pro.** A live call proved
  `gemini-pro-latest` resolves to `gemini-3.1-pro`, which has a **free-tier quota
  of zero** — it 429s immediately. Set `GEMINI_MODEL=gemini-pro-latest` if the
  key is on a paid plan.
- Gemini failure mapping matches Claude's, so the watermark rules behave
  identically: `MAX_TOKENS` → truncated, `SAFETY`/`RECITATION`/`PROHIBITED_CONTENT`
  → refusal, blocked prompt → refusal, 429 → provider_error, 403 → missing key.
  "Thought" parts are filtered out so reasoning can never be stored as a
  translated paragraph.

## Phase 6 — Glossary ✅

- [x] `GlossaryTerm` CRUD API (`/api/books/:id/glossary`)
- [x] Simple glossary editor UI on the book detail page
- [x] Wire glossary terms into the translate prompt for **both** providers
      (confirm it's actually being injected, not just a stub)

Notes:
- Editor lives at `/books/:id/glossary`, linked from the reader header. Kept off
  the reader itself so the reading surface stays uncluttered.
- API: `GET`/`POST /api/books/:id/glossary`, `PATCH`/`DELETE
  /api/books/:id/glossary/:termId`. `PATCH` is field-by-field, so
  `{"translation": null}` clears the translation without touching the note.
- Empty translation = "keep unchanged" (GLOSSARY.md), stored as `null` and shown
  as *biarkan apa adanya*.
- Duplicate term → 409 via an explicit pre-check, so the message names the term
  instead of surfacing a raw unique-constraint error.
- **Dual-provider injection verified by assertion, not inspection**: the same
  batch was run against both clients with `fetch` stubbed, request URLs checked
  (`anthropic.com` vs `googleapis.com`), and the glossary lines found in
  Anthropic's `system` *and* Gemini's `systemInstruction` — which are
  byte-identical. Also verified a term added later shows up in the next batch,
  and that an empty glossary still produces a sane prompt.
- **`src/lib/glossary-schema.ts` exists for a reason**: `glossary.ts` imports
  Prisma, and a `"use client"` component importing a runtime value from it drags
  the native binding into the browser bundle (`Can't resolve 'fs'` at the time
  — SQLite/better-sqlite3; now `Can't resolve 'net'`/`'tls'` since Phase 7's
  Postgres switch, same underlying problem). `tsc` and `eslint` both pass in
  that state — only loading the page catches it. Client components import
  categories/types from the schema module.
- **Hardened afterwards** so the same mistake can't be made silently again:
  - `import "server-only"` added to every Prisma / filesystem / API-key module
    (`db`, `books`, `reader`, `glossary`, and `translator/*` except the pure
    `types.ts` and `parseResponse.ts`). Verified by deliberately re-introducing
    the bad import: the build now fails naming `server-only` and the offending
    file, instead of `Can't resolve 'fs'` inside `node_modules`.
  - `src/lib/reader-schema.ts` added, mirroring `glossary-schema.ts`, so the
    reader's Client Components no longer reference `@/lib/reader` at all. (Those
    were `import type` and therefore erased — safe, but one keystroke from
    breaking.)
  - Rule documented in CLAUDE.md, SPEC.md §4.1, and GLOSSARY.md.

## Phase 7 — Polish / Remaining Features (only after MVP fully works)

- [x] EPUB parser (`src/lib/parser/epub.ts`)
      - Deps: `fflate` (unzip) + `fast-xml-parser`, both pure JS — no native
        bindings, so nothing new to worry about at the server/client boundary.
      - Reading order comes from the OPF **spine**, never zip entry order.
        `chapterIndex` = spine document index. Handles `../` and
        percent-encoded hrefs, missing `container.xml` (scans for the `.opf`),
        missing/non-XHTML spine targets (skipped), and single-item
        manifests/spines.
      - Malformed EPUB → `EpubParseError` → HTTP 422 with a readable message;
        `.txt` upload behaviour unchanged.
      - **Regression found and fixed while testing**: adding `import
        "server-only"` broke `bun run db:seed`, because the guard only compiles
        away under the `react-server` export condition, which plain Node does
        not set. Seed command is now
        `tsx --conditions=react-server prisma/seed.ts`; documented in CLAUDE.md.
- [ ] PDF parser (`src/lib/parser/pdf.ts`) with cleanup/preview step
- [ ] Provider fallback logic (try primary, fall back to the other provider on
      rate limit / error)
- [ ] Background pre-translation (translate ahead while reading)
- [ ] Export translated book to `.txt`
- [x] Book upload UI + delete book (pulled forward on user request — the app
      previously opened straight into existing books with no way to add or
      remove one from the UI)
      - `UploadBookForm` on `/books`: file (.txt/.epub) + optional title/author,
        posts to the existing `POST /api/books`; empty fields are omitted so the
        filename-fallback title still applies.
      - `DELETE /api/books/:id` implemented (was planned in SPEC.md §4 since
        Phase 1 but never built). Cascade removes paragraphs, progress, and
        glossary; verified zero orphan rows afterwards. **Deleting destroys the
        translated text too**, so the button's confirm dialog says exactly that.
      - Delete again / unknown id → 404.
- [x] Reader pagination upgrade (ad hoc user request — Previous/Next-only
      navigation was unusable on long novels)
      - [x] Numeric pagination: `src/components/Pagination.tsx`, a generic
            First/Prev/[1 … 8 9 **10** 11 12 …]/Next/Last control with no
            reader-specific knowledge (caller supplies `getHref`).
      - [x] Windowed pagination: page-number list length is bounded by sibling
            count (≈9 items), never by `totalPages` — verified a 100-page book
            renders the same button count as a 10-page one. Unrelated to, and
            in addition to, the paragraph windowing that's existed since Phase 4.
      - [x] Responsive pagination: two layouts (mobile compact, desktop full),
            toggled with `sm:hidden`/`hidden sm:flex`, not a JS media query —
            avoids a hydration mismatch, since the server can't know viewport
            width. All controls ≥44×44px.
      - [x] Accessibility: `<nav aria-label>` + `<ul>/<li>`, `aria-current="page"`
            on the active page, `aria-label` on every control, disabled ends are
            real `<button disabled>` (an `<a>` has no accessible disabled
            state), ellipses `aria-hidden`. Native `<a>`/`<button>` elements, so
            keyboard Tab/Enter/Space and focus-visible work with no custom
            handling.
      - [x] Pagination state management: the URL (`?page=N`) is the only source
            of truth — no component state duplicates it. `getReaderPage` now
            takes `requestedPage` instead of `requestedFrom`;
            `pageForIndex`/`fromForPage`/`totalPagesFor` (pure, in
            `reader-schema.ts`) convert between an absolute `orderIndex` and a
            page number wherever needed (the reader itself, and the library's
            "Lanjut menerjemahkan" link).
      - Verified: pure range-generator functions (31 checks: exact spec example
        `1 … 8 9 10 11 12 … 35`, mobile `9 10 11`, boundary/edge cases) +
        end-to-end against a live 320-paragraph/11-page test book (resume,
        direct page jump, out-of-range clamp, non-numeric fallback, mark-read
        keeping the same page, disabled-state placement) + screenshots at
        desktop and 375px mobile widths.
      - SPEC.md §3.3.1 is the source of truth for the behavior; see also
        CLAUDE.md's new "Reusable UI Components" and "URL-Driven State" notes.
- [x] Explicit translate start index (`fromIndex`) (ad hoc user request — user
      had read ahead to #180 while translation was stuck at #33 and asked
      whether translation could jump to wherever they're reading instead of
      only ever continuing in order)
      - `POST /api/translate` accepts an optional `fromIndex`; `translateNextBatch`
        anchors its pending-paragraph search there instead of at
        `lastTranslatedIndex` when given.
      - `lastTranslatedIndex` semantics changed from "always the end of the
        just-written batch" to "last index before the next untranslated gap",
        recomputed from actual DB state after every batch
        (`advanceWatermark` in `translateNextBatch.ts`) — this is what lets a
        later batch auto-close an earlier gap in one step, and what makes
        translating out of order safe: nothing reading `lastTranslatedIndex`
        elsewhere (progress bars, "Lanjut menerjemahkan") can end up claiming
        an untranslated paragraph is done. `firstUntranslatedIndex` /
        `translatedCount` were already plain queries, not watermark-derived,
        so they needed no change.
      - `TranslateFromHereButton` (new, `components/reader/`): per-paragraph
        trigger next to every untranslated paragraph, self-contained like
        `TranslateBatchButton` (own fetch/busy/error state, `router.refresh()`
        on success) rather than routed through `ReaderView`'s state, matching
        the existing per-control-owns-its-request pattern.
      - Verified: 12 assertions against a stub `TranslationProvider` (no real
        API calls) covering jump-ahead-leaves-gap, DB state after the jump,
        gap-fill advancing the watermark past the whole now-contiguous
        stretch in one step, done-state on a fully translated book, and
        rejection of an out-of-range `fromIndex` — plus a live screenshot
        confirming the button renders once per untranslated paragraph.
      - SPEC.md §3.2 documents the new `fromIndex` behavior and the
        recomputed-watermark rule.
- [x] Revert a read paragraph back to unread (ad hoc user request, follow-up
      to the `fromIndex` one above)
      - No backend change needed: `setLastReadIndex` already allowed moving
        `lastReadIndex` backward (`reader.ts` already documented this as
        intentional — "re-reading an earlier chapter is a normal thing to
        do"). Purely a UI gap.
      - `ParagraphBlock` gained an `onMarkUnread` control next to "Sudah
        dibaca" on every read paragraph; `ReaderView`'s `markUnread(orderIndex)`
        calls the same progress PATCH as `markRead`, just with
        `orderIndex - 1`.
      - Busy-state tracking (`markingIndex`) is keyed to the *clicked*
        paragraph, not the value sent to the API — `markUnread(50)` sends
        `lastReadIndex: 49` but still shows "Menyimpan…" on paragraph #50,
        via a shared `updateLastReadIndex(newValue, markingKey)` helper.
      - Since `lastReadIndex` is a single watermark, reverting paragraph N
        also reverts everything after it (documented in SPEC.md §3.3) — the
        same contiguity rule "mark read up to here" already has, just
        backward. No confirm dialog: consistent with the rest of the app,
        where only book deletion (destroys data) requires one.
      - Verified: live PATCH against a 6-paragraph test book with
        `lastReadIndex=4`, reverting paragraph #2 → `lastReadIndex` becomes 1
        and the read/unread button counts flip from 5/1 to 2/4 exactly as
        expected.
- [x] "Jump to my position" shortcuts in the reader header (ad hoc user
      request, follow-up to the two above — browsing via numeric pagination
      can land far from either watermark)
      - Two `GoToPageButton`s (local to `ReaderView.tsx`, not extracted —
        only used twice, no second use case yet): "Ke posisi baca terakhir"
        → `pageForIndex(lastReadIndex + 1)`, "Ke batas terjemahan terakhir"
        → `pageForIndex(lastTranslatedIndex + 1)`. Pure navigation
        (`next/link`), no fetch — same URL-is-source-of-truth pattern as the
        rest of pagination.
      - Whichever target equals the page already being viewed renders as a
        real disabled `<button>`, not a dead link — same rule `Pagination.tsx`
        already follows for its First/Prev/Next/Last ends.
      - Verified: 100-paragraph test book with `lastReadIndex=95` (page 4) and
        `lastTranslatedIndex=10` (page 1), viewed from page 2 — both render as
        links to the right page; viewing page 4 disables the read shortcut,
        viewing page 1 disables the translate shortcut. Screenshot confirms
        layout.
      - SPEC.md §3.3 documents both shortcuts.
- [x] PWA / lightweight offline caching (ad hoc user request — user picked
      the "cache pages already opened" scope out of three offered options,
      not a full offline-first client-data rewrite)
      - Installable: `src/app/manifest.ts` (Next file convention, auto-linked)
        + `public/icons/icon.svg` (SVG-only, no PNG generation — Chrome/Edge
        install works fine with `sizes: "any"`; iOS home-screen icon quality
        is a known, accepted gap, not addressed here) + `src/app/icon.svg`
        (favicon).
      - Hit a real Next.js API-drift issue while wiring this up (matches the
        class of thing CLAUDE.md warns about elsewhere): `metadata.themeColor`
        is rejected by this Next.js version with a build warning — it moved to
        a separate `viewport` export (confirmed via
        `node_modules/next/dist/docs/.../generate-viewport.md` before fixing,
        not guessed). `layout.tsx` now exports both `metadata` and `viewport`.
      - `public/sw.js`: network-first-with-cache-fallback for every
        same-origin GET (navigations, RSC fetches, static assets); mutations
        (POST/PATCH/DELETE) are never intercepted. `RegisterServiceWorker.tsx`
        registers it client-side, **production builds only** (a SW caching
        hashed chunks fights `next dev`'s hot reload).
      - `public/offline.html`: static fallback shown for a navigation to a
        page that was never cached and the network is down.
      - Verified: `tsc`/`eslint`/`bun run build` clean. Live test against a
        production build (`bun run start`) with a persistent headless-Chrome
        profile: warmed the cache by visiting `/books` then a book page, then
        killed the server entirely and reloaded — the book page rendered its
        real cached content offline, and a third, never-visited page (the
        glossary) correctly showed `offline.html`. `/books` itself came back
        as `offline.html` on the same run, which turned out to be expected,
        not a bug: it was the very first page ever opened in that profile,
        so the service worker wasn't active yet when *that* request went out
        (standard SW behavior — the registering page is never covered by its
        own registration; every visit after it is). Cache Storage on disk
        (`Service Worker/CacheStorage`) confirmed entries were written.
      - SPEC.md §3.5 is the source of truth for scope and the first-visit
        caveat above.
- [x] VPS deployment via Docker + Drone CI (ad hoc user request — adapted from
      the user's existing Drone CI / Nginx Proxy Manager pattern used for
      other apps) — **superseded by the Postgres-switch entry directly below**;
      left in place as the record of what was tried first and why it changed.
      - Stripped Postgres/MinIO/SMTP/Google OAuth/`DATA_ENCRYPTION_MASTER_KEY`
        from the reference — none apply here (SQLite, no file storage beyond
        the DB, no auth by design). Kept the same pipeline shape (`write-env`
        → `deploy` steps, Vault-backed secrets, `docker compose down && up -d
        --build`).
      - **Runtime decision reversed mid-task based on evidence, not
        assumption**: user's default preference was Bun (matches their other
        apps), but Bun 1.3.x fatally crashes loading `better-sqlite3`'s native
        binding — verified on both macOS and Linux/arm64 via Docker before
        concluding it's a genuine Bun bug, not a local config problem, then
        confirmed the Node.js fallback with the user rather than silently
        picking one. `Dockerfile` uses `node:20-slim`.
      - `next.config.ts`: `output: "standalone"` +
        `outputFileTracingIncludes` for `better-sqlite3` (prebuilt binary path
        is computed dynamically per platform/arch — a static tracer can miss
        it; belt-and-suspenders rather than assuming it's caught).
      - `migrate` one-shot service (`prisma migrate deploy`) shares a named
        SQLite volume with `app`, gated by
        `depends_on: condition: service_completed_successfully` — same shape
        as the reference's Postgres migrate step, minus the health-check
        (no separate DB server to wait for).
      - Both `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` wired as secrets so
        `TRANSLATION_PROVIDER` can be flipped without a code change.
      - **Not verified end-to-end** — the local `docker build` was slow enough
        that the user asked to skip it and report back from the actual VPS
        deploy instead. SPEC.md §7.2 lists the three most likely failure
        points to check first if the first Drone deploy fails.
      - **What the user reported back from the real deploy, in order**:
        1. `prisma generate` failed at build time — `RUN npx prisma generate`
           was placed *before* the `ARG`/`ENV DATABASE_URL` lines in the
           Dockerfile, so the config loader had nothing to resolve. Fixed by
           reordering.
        2. The rebuilt image still crashed at runtime: "Could not locate the
           bindings file" for `better-sqlite3`, nested under
           `@prisma/adapter-better-sqlite3/node_modules/` (a private copy,
           since the adapter's own `better-sqlite3` dependency range didn't
           match the project's top-level one). Root cause, found by inspecting
           the copied directory inside the container: `--ignore-scripts` on
           `npm ci` (added earlier to dodge issue #1 a different way) also
           silently skipped `better-sqlite3`'s own install step — the one that
           actually fetches/builds the native binary — leaving only source
           files (`lib/`, `src/`, `binding.gyp`) with nothing to bind to.
      - Both fixes verified locally afterward (`docker compose up` against a
        real container, `/books` responding 200) before being superseded by
        the Postgres switch below, which removes this entire class of problem.
- [x] Switch database from SQLite to PostgreSQL (explicit user request, for
      both dev and the VPS — Prisma's schema/migrations are tied to one
      provider, so a split setup would mean hand-maintaining two migration
      sets; not worth it here)
      - `prisma/schema.prisma`: `provider = "postgresql"`. `src/lib/db.ts`:
        `PrismaPg({ connectionString })` replaces `PrismaBetterSqlite3`.
        `package.json`: `pg` + `@prisma/adapter-pg` (+ `@types/pg`) replace
        `better-sqlite3` + `@prisma/adapter-better-sqlite3`.
      - `prisma/migrations/` deleted and regenerated from scratch against a
        real local Postgres (`prisma migrate dev --name init`) — SQLite and
        Postgres SQL dialects aren't compatible, so the old migration
        couldn't be carried over.
      - This resolves every native-binding problem logged in the entry above,
        as a side effect rather than a direct fix: `pg` is pure JS, so there's
        nothing to compile, nothing for `--ignore-scripts` to silently skip,
        and nothing for output-file tracing to miss. Dockerfile's `deps` stage
        went back to `--ignore-scripts` (safe now — no install script needs
        to run), and `next.config.ts`'s `outputFileTracingIncludes` was
        removed entirely.
      - `docker-compose.yml` gained a `postgres` service (matching the
        original reference pattern this deployment was adapted from, per
        SPEC.md §7.2), bound to `127.0.0.1` only (tighter than the reference —
        nothing outside the Docker network needs to reach it). `migrate` now
        gates on `postgres`'s healthcheck instead of just a shared volume.
      - Verified end-to-end locally before handoff: `docker compose up`
        against a real Postgres container, `migrate` applying cleanly, `app`
        booting, and a full create → read → delete cycle through the real
        API (upload a book, confirm it lists and its reader page renders,
        delete it, confirm the cascade) — not just a page load.
      - SPEC.md §7.1 documents the switch; §7.2 (deployment) updated to match.
- [x] Fix the VPS deploy failing at the migration step, and re-sync the docs
      with the deployment files (ad hoc user request)
      - **Root cause of `P1001: Can't reach database server at postgres:5432`**:
        the Compose service was renamed `postgres` → `db` (commits 07eb202,
        e533164), but the `DATABASE_URL` in `migrate`'s and `app`'s
        `environment:` blocks still said `@postgres:5432`. Postgres itself was
        healthy — `db`'s healthcheck passed and gated `migrate` correctly; the
        host name just didn't resolve on the Compose network. Fixed by pointing
        both at `@db:5432`.
      - `migrate` went from `restart: on-failure` to `restart: "no"` — the
        healthcheck already proves the server is up, so a failure here is a
        real migration problem, and the retry loop is why the same P1001 was
        printed four times over. `.drone.yml`'s deploy step now always runs
        `docker compose logs migrate` after `up`, so the reason is in the CI
        log without SSH-ing to the VPS.
      - Removed the `DATABASE_URL` Drone/Vault secret and its `write-env` line:
        `docker-compose.yml` derives the container-side URL from `POSTGRES_*`
        and never reads `${DATABASE_URL}`, so that secret was a second,
        unused source of truth for the host name — exactly the thing that
        drifted. `.env`'s `DATABASE_URL` (localhost:5439) stays, for host-side
        Prisma CLI / `bun run dev` only.
      - `db`'s host port is now actually bound to `127.0.0.1` (`5439:5432` had
        been publishing on all interfaces, including the VPS's public one —
        SPEC.md §7.2 had claimed 127.0.0.1 since the Postgres switch).
      - Dockerfile: `ARG`/`ENV DATABASE_URL` moved back above
        `bunx prisma generate` in `builder` — the regression that broke the
        first VPS deploy had reappeared. `deps` now installs with
        `--ignore-scripts` instead of also being given a `DATABASE_URL`
        (the first attempt here): its `postinstall: prisma generate` was
        writing to `../src/generated/prisma` in a stage that has no `src/`,
        and only `node_modules` is carried into `builder`, so it was pure
        waste. Safe only while every dependency is script-free — true now
        that the driver is `pg`, and the reason this flag is called out in
        SPEC.md §7.2.
      - **Docs re-synced to what the files actually do**: SPEC.md §7 (both env
        files, port 5439, why containers can't use `DATABASE_URL`) and §7.2
        (service named `db`, runtime is Bun not `node:20-slim`, Drone has no
        `DATABASE_URL` secret); CLAUDE.md's deployment notes; README's quick
        start; `.env.local.example` (5439 not 5437, `docker compose up -d db`
        not `... postgres`, plus the `POSTGRES_*`/`APP_PORT` keys Compose
        requires, which the template had never listed).
      - Verified locally with `docker compose up -d --build` against a real
        Postgres container before handoff, not just `docker compose config`.

- [x] Library: fix the upload button's missing loading state, and add sorting
      (ad hoc user request)
      - **Upload loading state never appeared.** `UploadBookForm` tracked
        `isUploading` in `useState`, set `true` at the top of the form action
        and `false` in its `finally`. React runs a function `action` inside a
        transition, so both updates belonged to the same transition and were
        collapsed — only the final `false` was ever committed, so the button
        kept saying "Unggah" for the whole upload. Replaced with a
        `SubmitButton` child calling `useFormStatus()` (must be a child: the
        hook reads the nearest parent form).
      - Verified in a real browser (Playwright driving installed Chrome, with
        the `/api/books` response held open 2s so the pending window is
        observable, since a small file parses too fast to catch): label →
        "Mengunggah…", button disabled, hint shown, then all three revert.
        The same probe was run against the pre-fix file from git — it fails
        there and passes after, so the diagnosis is confirmed, not assumed.
      - **Sorting**: `?sort=` on `/books` with six orders (newest/oldest added,
        title A–Z/Z–A, most read, most translated). URL-based, not component
        state, so it survives reload and Back and stays bookmarkable; the
        default is the bare `/books` so there's one canonical URL. Options live
        in the new `src/lib/books-schema.ts` (no Prisma import) and are shared
        by the server page and the client `BookSortSelect`.
      - Ranking runs in `listBooksWithProgress` over the derived summaries, not
        as a Prisma `orderBy`: the progress orders key off percentages that
        aren't columns. Comparators use exact ratios rather than the rounded
        displayed percent (2/3 vs 67/100 would otherwise tie), and rely on JS
        sort stability so ties fall back to newest-first.
      - Verified all six orders plus an invalid `?sort=bogus` (falls back to
        the default rather than erroring), and in-browser: select → URL
        changes, reload and Back both preserve the order, choosing the default
        returns to bare `/books`. Title sort confirmed case-insensitive —
        `middlemarch` lands between `Anna Karenina` and `zebra-tale`.

- [x] Reader: "Go to page" jump control for long books (ad hoc user request —
      190-page novels made the windowed page numbers impractical)
      - `src/components/GoToPage.tsx`, generic and presentation-only like
        `Pagination.tsx` beside it (page numbers in, `getHref` out — no book or
        paragraph knowledge). The existing pagination is untouched and still
        works; the jump control sits beside it on desktop, below it on mobile.
      - Mobile gets a native full-width `<select>` (OS picker, 44px tall);
        desktop gets a number input + `<datalist>` so typing `150` narrows to
        "Halaman 150" and Enter jumps. A plain `<select>` can't do the typing
        part — its type-ahead matches option text from the start, so "150"
        never finds "Halaman 150". Both are rendered and toggled by CSS
        breakpoint, the same rule `Pagination` already follows.
      - **Two bugs found by testing in a browser, not by reading the code** —
        both would have passed `tsc`/`eslint`/build:
        1. Typing an out-of-range page did nothing. `max={totalPages}` makes
           the browser run constraint validation *before* `onSubmit`, so the
           clamp never executed. Fixed with `noValidate`.
        2. Focus was dropped to `<body>` on every jump (App Router resets it),
           stranding keyboard users. Confirmed via a tagged DOM node that the
           input is *not* remounted across the navigation, so the fix restores
           focus rather than fighting a re-render — guarded on `<body>` still
           holding focus so it never yanks it back from elsewhere.
      - Verified against a real 5700-paragraph / 190-page book, 28 checks at
        1280px and 320px: jump in one action, active page always selected,
        value re-syncs after navigating, no document reload, no horizontal
        overflow (scrollWidth 320 = clientWidth 320), Prev/Next fully on screen
        and ≥44px, old pagination still working with its ellipses intact, and
        reading progress unchanged by jumping (marked #89 on page 3, jumped to
        160 and back, still "Dibaca: 90 / 5700").

## Non-Negotiables (recheck before marking any phase done)

- [ ] `orderIndex` is never inferred from text matching, only from stored order
- [ ] A failed translate batch never advances `lastTranslatedIndex`
- [ ] Progress survives a full app restart
- [ ] No Client Component imports a runtime value from a Prisma-touching module
      (SPEC.md §4.1). `tsc` and `eslint` do not catch this — run `bun run build`
      and open the affected page before calling a UI phase done.