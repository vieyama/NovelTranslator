# Novel Translator — Personal Reading App

A personal app for reading English novels with on-demand AI-generated Indonesian
translations, with automatic progress tracking (no more manually copy-pasting the
last sentence into a PDF reader to find your place).

## Why this app exists

Previous manual workflow:
1. Copy a paragraph from the novel → paste into an AI chat → wait for the result → read.
2. Because free-tier AI has a character limit, only a few paragraphs could be
   translated at a time.
3. If you forgot where you left off, you had to check the last AI chat message,
   copy the last sentence, and search for it in the PDF reader.

This app removes the manual steps above by:
- Parsing the novel into paragraph units stored in a local database.
- Tracking each paragraph's status (`not translated` / `translated`).
- Automatically saving the last read position and last translated position per book.
- Translating in automatic batches (sized to fit the character limit), so you just
  click "next" to continue.

## Tech Stack

- **Next.js (App Router) + TypeScript** — UI reader & API routes
- **PostgreSQL** (via Prisma + `pg`) — local dev via `docker compose up -d postgres`, same engine on the VPS
- **Anthropic API / other AI provider** — translation engine
- **Tailwind CSS** — fast styling

## Project Status

🚧 Planning stage. See:
- `SPEC.md` — full technical spec / PRD
- `TRANSLATION_RULES.md` — the translation prompt & rules (editable)
- `GLOSSARY.md` — per-book terminology consistency
- `TASKS.md` — step-by-step implementation checklist
- `CLAUDE.md` — guidance for Claude Code working in this repo

## Quick Start (once scaffolding is done)

```bash
npm install
npx prisma migrate dev
npm run dev
```

## Folder Structure (planned)

```
novel-translator/
├── prisma/
│   └── schema.prisma
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── translate/route.ts
│   │   │   └── books/[id]/route.ts
│   │   ├── books/[id]/page.tsx      # reader view
│   │   └── page.tsx                  # library / book list
│   ├── lib/
│   │   ├── db.ts
│   │   ├── parser/                   # epub/txt/pdf parser
│   │   └── translator/               # AI translation client
│   └── components/
├── CLAUDE.md
├── SPEC.md
└── README.md
```