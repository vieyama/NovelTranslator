import {
  AiSettingsError,
  activateApiKey,
  addApiKey,
  deleteApiKey,
} from "@/lib/ai-settings";
import { UnauthorizedError, requireApiUser } from "@/lib/session";

// Decrypts secrets with node:crypto and talks to Postgres — Node runtime only.
export const runtime = "nodejs";

/**
 * Saved API keys (SPEC.md §8.5).
 *
 * Separate from `/api/settings/ai`, which handles provider and model: adding a
 * key, switching to another, and deleting one are distinct actions on a list,
 * not fields of a form. Folding them into the settings PUT would have meant a
 * mode flag and a body whose meaning changed with it.
 *
 *   POST   { provider, apiKey, label? }  — save another key
 *   PATCH  { keyId }                     — make it the active one
 *   DELETE { keyId }                     — remove it
 *
 * Every response is the refreshed settings view, so the client never has to
 * guess what the list looks like afterwards. The plaintext key is never in it.
 */

export async function POST(request: Request) {
  return handle(request, async (userId, body) => addApiKey(userId, body as never));
}

export async function PATCH(request: Request) {
  return handle(request, async (userId, body) =>
    activateApiKey(userId, (body as { keyId?: unknown }).keyId),
  );
}

export async function DELETE(request: Request) {
  return handle(request, async (userId, body) =>
    deleteApiKey(userId, (body as { keyId?: unknown }).keyId),
  );
}

async function handle(
  request: Request,
  action: (userId: string, body: unknown) => Promise<unknown>,
): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const user = await requireApiUser();
    const settings = await action(user.id, body ?? {});

    return Response.json({ settings });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof AiSettingsError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    // Never echo the raw error: it can carry fragments of key material or
    // ciphertext from the crypto layer.
    console.error("API key operation failed:", error);
    return Response.json({ error: "Gagal memproses API key." }, { status: 500 });
  }
}
