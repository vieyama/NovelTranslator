<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project Notes

- Read `SPEC.md` and `TASKS.md` before changing app behavior.
- Token usage from translation is stored per book, provider, and model in
  `BookTokenUsage`; do not merge model/provider totals into a single `Book`
  counter.
- PDF upload is implemented through `src/lib/parser/pdf.ts` using `pdf-parse`;
  treat PDF paragraph splitting as heuristic and preserve `orderIndex` ordering.
