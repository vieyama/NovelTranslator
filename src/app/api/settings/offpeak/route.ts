import {
  getOffPeakSettingsView,
  OffPeakSettingsError,
  saveOffPeakSettings,
} from "@/lib/offpeak-settings";
import type { SaveOffPeakSettingsInput } from "@/lib/offpeak-settings-schema";
import { requireApiUser, UnauthorizedError } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireApiUser();
    return Response.json({ settings: await getOffPeakSettingsView(user.id) });
  } catch (error) {
    return toResponse(error, "Gagal memuat otomatisasi.");
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const user = await requireApiUser();
    const settings = await saveOffPeakSettings(
      user.id,
      (body ?? {}) as SaveOffPeakSettingsInput,
    );
    return Response.json({ settings });
  } catch (error) {
    return toResponse(error, "Gagal menyimpan otomatisasi.");
  }
}

function toResponse(error: unknown, fallback: string): Response {
  if (error instanceof UnauthorizedError || error instanceof OffPeakSettingsError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 500 });
}
