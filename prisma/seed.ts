/**
 * Seeds one dummy book so the data layer can be verified manually in
 * `npx prisma studio` (TASKS.md Phase 1).
 *
 * Run with: bun run db:seed
 *
 * Idempotent — deletes any previous copy of the seed book first (paragraphs,
 * progress and glossary terms cascade), so it can be re-run freely.
 */
import { config as loadEnv } from "dotenv";

// Must run before src/lib/db is loaded — that module reads DATABASE_URL at
// import time, so db.ts is pulled in dynamically inside main() below.
loadEnv({ path: ".env.local" });

const SEED_TITLE = "[SEED] The Ashveil Chronicle";

// Deliberately varied lengths so batching (Phase 3, maxChars) has something
// non-uniform to group, and includes names/skills the glossary below covers.
const PARAGRAPHS = [
  "Arthur woke before dawn, as he always did, to the sound of rain against the shutters.",
  "The Black Forest had swallowed three patrols that month. Nobody said it out loud, but every soldier in the Iron Legion counted the empty bunks each morning and did the arithmetic in silence.",
  '"You are going, then," Elara said. It was not a question.',
  "He fastened the last strap of his pack and did not look up. There was nothing to say that would not sound like a lie.",
  '"Fireball," he muttered, and the damp kindling caught at once, hissing as the water boiled out of it. Mana Burst would have been faster, but he had learned long ago not to waste what he could not replace.',
  "Outside, the rain kept falling. Somewhere beyond the treeline, something very large moved through the dark, and the birds went quiet all at once.",
];

async function main() {
  const { prisma } = await import("../src/lib/db");

  await prisma.book.deleteMany({ where: { title: SEED_TITLE } });

  const book = await prisma.book.create({
    data: {
      title: SEED_TITLE,
      author: "Dummy Author",
      sourceFormat: "txt",
      totalParagraphs: PARAGRAPHS.length,
      paragraphs: {
        create: PARAGRAPHS.map((text, index) => ({
          orderIndex: index,
          originalText: text,
          charCount: text.length,
          // First two are pre-translated so the "translated vs not" split and
          // the progress indexes below are visible in Prisma Studio.
          translatedText:
            index === 0
              ? "Arthur terbangun sebelum fajar, seperti biasa, oleh suara hujan yang menghantam daun jendela."
              : index === 1
                ? "Black Forest sudah menelan tiga regu patroli bulan itu. Tidak ada yang mengatakannya terang-terangan, tapi setiap prajurit Iron Legion menghitung ranjang kosong tiap pagi dan diam-diam menjumlahkannya sendiri."
                : null,
          translatedAt: index <= 1 ? new Date() : null,
        })),
      },
      progress: {
        create: {
          // Paragraphs 0 and 1 are translated; the user has read only 0.
          lastTranslatedIndex: 1,
          lastReadIndex: 0,
        },
      },
      glossaryTerms: {
        create: [
          { term: "Arthur", translation: null, category: "character", note: "Names stay as-is" },
          { term: "Elara", translation: null, category: "character", note: "Names stay as-is" },
          { term: "Black Forest", translation: null, category: "place", note: "Place names stay as-is" },
          { term: "Iron Legion", translation: null, category: "organization", note: "Organization name kept" },
          { term: "Fireball", translation: null, category: "skill", note: "Unique skill, kept in English" },
          { term: "Mana Burst", translation: null, category: "skill", note: "Unique skill, kept in English" },
          { term: "potion", translation: "ramuan", category: "item", note: "Generic item — translated" },
        ],
      },
    },
    include: { progress: true, _count: { select: { paragraphs: true, glossaryTerms: true } } },
  });

  console.log(`Seeded book ${book.id} — "${book.title}"`);
  console.log(`  paragraphs:    ${book._count.paragraphs} (totalParagraphs=${book.totalParagraphs})`);
  console.log(`  glossaryTerms: ${book._count.glossaryTerms}`);
  console.log(
    `  progress:      lastTranslatedIndex=${book.progress?.lastTranslatedIndex}, lastReadIndex=${book.progress?.lastReadIndex}`,
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
