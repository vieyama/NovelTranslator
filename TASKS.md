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

- [x] Authentication (NextAuth email+password) + AI settings with encrypted
      API keys (explicit user request; supersedes the original "no auth needed")
      - **Three decisions confirmed with the user before building**, because
        each changed a lot: full multi-user (per-user libraries) over a bare
        login gate; master key in env over the originally-proposed
        username-derived key; no public sign-up.
      - **The proposed encryption scheme had a real flaw, and was changed.**
        The original idea stored the key-encrypting key in the user table,
        wrapped with something derived from the username. Both halves then live
        in the same database, so a dump contains everything needed to unwrap it
        — the encryption would have protected against nothing but casual
        browsing. Replaced with envelope encryption rooted in
        `APP_ENCRYPTION_KEY` (env, never stored), and the user id kept as GCM
        **AAD** rather than key material — which is what the "combine with the
        username" instinct was actually reaching for: it binds a ciphertext to
        its owner so rows can't be swapped between users. SPEC.md §8.3.
      - `Book.userId` is nullable because books predate auth and the migration
        had to run against a populated database. The first account created
        claims all unowned books; later accounts deliberately do not.
      - Someone else's book is a **404, not a 403** — a 403 confirms the id
        exists, which is what a probe wants.
      - `src/proxy.ts`, not `middleware.ts`: Next 16 renamed the convention
        (and Proxy now defaults to the Node runtime). It excludes `/api/*` on
        purpose — redirecting a `fetch` to an HTML login page produces
        "can't reach server" instead of "signed out". Real enforcement is
        `requireUser`/`requireApiUser` in every page and route.
      - scrypt from `node:crypto` for passwords, not bcrypt/argon2: both ship
        native bindings, and this repo has already lost a day to one (§7.1).
      - **Removed the module-level SDK client cache in both provider clients.**
        Harmless while the key came from one env var; with per-user keys it
        would have pinned the first user's key into the module and billed
        everyone else's translations to them.
      - **Bug found while testing the `user:create` script**: it opened a new
        readline interface per prompt. Closing one ends stdin, so the second
        prompt never resolved — with piped input the process then exited 0
        having written nothing, silently. Now one interface for interactive
        use, and a separate read-stdin-to-end path for piped input so the
        script is scriptable.
      - **Deploying this to an existing production database needed two extra
        pieces, both found by simulating the upgrade rather than reasoning
        about it.** Restored a database at the old schema, filled it with
        production-like rows, then ran `prisma migrate deploy`: the migration
        is purely additive and book, paragraphs, glossary and both progress
        watermarks (1200/900) all survived. But every book came out with
        `userId = NULL`, and since all queries filter by owner the library
        renders *empty* — indistinguishable from data loss to anyone looking
        at it.
        1. Accounts cannot be created on the VPS from the production image:
           `runner` holds only `.next/standalone`, with no `scripts/`, no
           `tsx`, no full `node_modules`. The `migrate` service (built from
           `builder`) is the only image that can, so it now carries
           `APP_ENCRYPTION_KEY` as well.
        2. `scripts/bootstrap-user.ts` + `BOOTSTRAP_USER_*` create the default
           account right after `migrate deploy`, which adopts those orphaned
           books automatically — no SSH step on first deploy. It never touches
           an existing account: re-applying the password every deploy would
           undo a password change and leave a stale Vault entry as a permanent
           way in. Verified across all five paths (unset, half-set, weak
           password, create, re-deploy), including that the original password
           still verifies and a changed Vault value does not.
      - Verified: 18 crypto/password checks (envelope round-trip, cross-user
        and cross-provider AAD rejection, tampered-ciphertext rejection, and
        that stolen rows without the env key cannot be decrypted), plus 27
        browser checks across two accounts — auth gate, wrong-password
        handling that doesn't reveal whether an account exists, complete data
        isolation (page + API: delete/progress/glossary/translate on another
        user's book all 404), settings round-trip, provider-dependent model
        list, and that the plaintext key never reaches the browser. A full
        `pg_dump` contains neither the API key nor any password.

- [x] Reader: scroll-to-paragraph on the position shortcuts, and move the
      batch-translate button out of the paragraph flow (ad hoc user request)
      - The two header shortcuts now navigate to `?page=N#p-{index}` and land on
        the paragraph itself. Target is the **last read / last translated**
        paragraph, so the page is `pageForIndex(index)` rather than `index + 1`;
        those differ only at a page boundary, where the old form jumped one page
        past the thing it named.
      - **Bug caught by testing, not by reading**: clicking the shortcut while
        already on that page did nothing, because the href equalled the current
        URL and the browser skipped the navigation. That is the most common case
        (read on, drift away, click to return). Fixed by scrolling the element
        directly when it is already in the DOM, respecting
        `prefers-reduced-motion`. `scroll-mt-24` on `ParagraphBlock` already
        kept the sticky bar clear — measured at 96px from the top after the jump.
      - The batch-translate button moved to the header. Inline it sat next to
        the first untranslated paragraph on screen and implied *that* index was
        the batch start, when the batch actually begins at the first
        untranslated paragraph in the whole book. The user read it exactly that
        way. Its label now states the real starting index ("Terjemahkan batch
        dari #0"). The batch anchor itself is unchanged — deliberately, since
        changing it would leave gaps the watermark-based progress percentage
        would then misreport.
      - **Follow-up in the same session**: `translatedPercent` was derived from
        `lastTranslatedIndex`, which stops at the first gap, so the library
        could show "Diterjemahkan 20/2879 (0%)" — count and percentage
        disagreeing on screen. Now counted instead, and the `translation` sort
        comparator moved to the same basis so ordering matches the figure shown.
        `readPercent` deliberately stays watermark-based: reading really is
        "read up to here", with no gap to disagree about. Verified against the
        exact scenario (0–10 untranslated, 11–30 translated, watermark -1):
        reads "20/2879 (1%)" where the old formula gave 0%.
      - Verified in a browser across 12 checks: cross-page jump scrolls and
        lands 96px from the top, re-click while already there re-scrolls,
        boundary index stays on its own page, `-1` renders a disabled button,
        no translate button remains inline, and the header label matches the
        book-wide next batch start.

- [x] Add Mistral as a third translation provider (user has a key; ad hoc request)
      - **No database migration**: `provider` is a string column and
        `AiProviderCredential` is already keyed by `(userId, provider)`, so the
        normalised shape chosen during the settings work paid off here.
      - `mistralClient.ts` uses plain `fetch`, not `@mistralai/mistralai` —
        that SDK pulls `ws`, `zod`, `zod-to-json-schema` and OpenTelemetry to
        wrap a single OpenAI-shaped POST. Defensive parsing throughout: content
        may be a string or an array of typed chunks, and non-text chunks are
        dropped so nothing but translation can reach `parseResponse`.
      - **Removed a latent drift**: `ProviderName` in `provider.ts` was declared
        independently of `AI_PROVIDERS`, so Settings could offer a provider with
        no factory behind it and still compile. It now derives from the schema —
        verified by deleting the factory and watching `tsc` fail with
        "Property 'mistral' is missing in type ...".
      - **All three provider keys are now optional in `docker-compose.yml`**, on
        the user's instruction to treat Mistral like the rest. `ANTHROPIC_` and
        `GEMINI_API_KEY` were still `:?`-required from before per-user keys
        existed, so a deploy would fail over a server-wide secret for a provider
        nobody uses from the server. The per-user key in `AiProviderCredential`
        is the real one; env is only the fallback, and a provider with no key
        anywhere now fails at translate time with a message pointing at
        Settings.
      - Verified: Mistral appears in Settings with its own models and no
        cross-contamination from the other providers, the key round-trips
        encrypted and is shown masked only, and a live call against the real
        endpoint with a deliberately invalid key returns Mistral's own
        `{"detail":"Invalid API Key"}` — proving URL, method and auth header
        are right — mapped to `missing_api_key` with progress untouched.
      - **Not yet verified**: a successful translation. That needs a valid key,
        so the request body, response parsing, `finish_reason` handling and
        `usage` field names are still only checked against the documented
        contract.

- [x] Add OpenRouter as a fourth provider (ad hoc user request)
      - **`validateModelName` rejected every OpenRouter model id.** Its charset
        had no `/`, and OpenRouter namespaces everything by vendor
        (`openai/gpt-4o`, `meta-llama/…:free`). Caught before writing the
        client by running the existing regex against real ids; left alone it
        would have failed at save time with a message about punctuation. Still
        deny-by-default — spaces and quotes remain rejected.
      - **Extracted `openAiCompatible.ts`** rather than copying the Mistral
        client: both providers are the same POST differing only in URL, default
        model and headers, so two copies would have drifted on the next fix.
        Mistral's client is now ~30 lines of configuration, and its full test
        suite was re-run afterwards to prove the refactor was behaviour-neutral.
      - OpenRouter proxies other vendors and reports *upstream* failures as HTTP
        200 with an `error` object rather than `choices`; handled explicitly, or
        it would surface as "returned no choices".
      - Model ids verified against OpenRouter's public catalogue endpoint (411
        models) instead of being written from memory — two plausible-looking
        `:free` ids turned out not to exist.
      - Verified: four providers listed, `/` and `:free` model names round-trip
        through save and reload, key stored encrypted and shown masked only, and
        a live call with an invalid key returns OpenRouter's own "User not
        found." — proving URL, headers and auth format are right — mapped to
        `missing_api_key` with progress untouched.
      - **The user pasted a live OpenRouter key into the chat** while asking for
        this. Flagged for rotation; it was never written to any file.
      - **Model list revisited** at the user's request, sourced from OpenRouter's
        "Top models used by Free Models Router". Every id and price was checked
        against `/api/v1/models` first, which is what caught that two of the five
        (`gpt-oss-120b`, `Tencent Hy3`) have **no `:free` variant** — appending
        the suffix, the obvious reading of that page, would have produced ids
        that fail at translate time. Listed at their real paid prices instead.
        Default moved from `openai/gpt-4o` to the largest genuinely free entry,
        and a check asserts the client's `defaultModel` still equals the first
        entry in `AI_PROVIDERS` (what the form shows as "Default (…)").
        `openrouter/free` is offered but never the default — random per-request
        routing would vary translation style between batches of one book.

- [x] Re-translate with undo (user request: "model A jelek, coba model B")
      - **Provenance was the missing half.** `Paragraph` recorded *when* it was
        translated but not *by what*, so after switching model there was no way
        to find the old model's output. `translatedBy` ("provider:model") makes
        the feature actionable; the migration is additive and existing rows stay
        null rather than being guessed at.
      - Batch, not single paragraph, decided deliberately: a paragraph redone
        alone loses the neighbouring context it originally had, so quality drifts
        from its surroundings — self-defeating for a feature whose purpose is
        better quality. Undo is per paragraph regardless, which is what makes the
        batch safe to accept.
      - Revert **swaps** current and previous rather than copying over, so undo
        is undoable — otherwise the trap just moves one step along.
      - `advanceWatermark` is deliberately *not* called on this path.
      - **Test bug worth remembering**: the fake provider counted paragraphs by
        splitting the prompt on `PARAGRAPH_SEPARATOR`, but the instruction line
        itself contains that string — so the count was off by one and the
        "returns the wrong count" provider accidentally returned the *right*
        count, turning a real assertion green-adjacent. Now read from the
        prompt's explicit "(N paragraphs" instead.
      - Verified without any API key by injecting fake providers through
        `retranslateBatch`'s `provider` seam — 24 checks: provider outage and
        paragraph-count mismatch both leave the old text and undo column
        untouched; a success replaces text, records new provenance, preserves
        the old text and its provenance, leaves the watermark at 40, and does
        not touch paragraphs before `fromIndex`; revert restores text *and*
        provenance and stays re-undoable; guards refuse reverting without a
        previous version, re-translating an untranslated paragraph, and another
        user's book (404). Plus 9 browser checks on the controls.

## Non-Negotiables (recheck before marking any phase done)

- [ ] `orderIndex` is never inferred from text matching, only from stored order
- [ ] A failed translate batch never advances `lastTranslatedIndex`
- [ ] Progress survives a full app restart
- [ ] No Client Component imports a runtime value from a Prisma-touching module
      (SPEC.md §4.1). `tsc` and `eslint` do not catch this — run `bun run build`
      and open the affected page before calling a UI phase done.