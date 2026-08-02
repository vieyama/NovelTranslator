import {
  AiSettingsError,
  getAiSettingsView,
  saveAiSettings,
  type SaveAiSettingsInput,
} from "@/lib/ai-settings";
import { UnauthorizedError, requireApiUser } from "@/lib/session";

// Decrypts secrets with node:crypto and talks to Postgres — Node runtime only.
export const runtime = "nodejs";

/** GET /api/settings/ai — current settings. Never includes the plaintext API key. */
export async function GET() {
  try {
    const user = await requireApiUser();

    return Response.json({ settings: await getAiSettingsView(user.id) });
  } catch (error) {
    return toResponse(error, "Gagal memuat pengaturan.");
  }
}

/**
 * PUT /api/settings/ai — save provider, model, and (optionally) the API key.
 *
 * Body: { provider, model?, apiKey? }
 *
 * Omitting `apiKey` leaves the stored key untouched, which is what lets the
 * form save a model change without asking the user to paste their key again;
 * sending `""` clears it and falls back to the server env var.
 */
export async function PUT(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const user = await requireApiUser();
    // Every field is validated inside `saveAiSettings`; an unknown provider
    // falls back to the default rather than erroring.
    const settings = await saveAiSettings(user.id, (body ?? {}) as SaveAiSettingsInput);

    return Response.json({ settings });
  } catch (error) {
    return toResponse(error, "Gagal menyimpan pengaturan.");
  }
}

function toResponse(error: unknown, fallback: string): Response {
  if (error instanceof UnauthorizedError || error instanceof AiSettingsError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  // Never echo the raw error: it can carry fragments of key material or
  // ciphertext from the crypto layer.
  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 500 });
}
