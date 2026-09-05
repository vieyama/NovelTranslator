export async function readApiError(
  response: Response,
  payload: unknown,
  fallback: string,
): Promise<string> {
  const message = extractError(payload);
  if (message) return message;

  const text = await response.text().catch(() => "");
  const snippet = stripHtml(text).slice(0, 160).trim();
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;

  return snippet ? `${fallback} (${status}: ${snippet})` : `${fallback} (${status})`;
}

export function isApiFailure(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "ok" in payload && payload.ok === false);
}

function extractError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return null;

  const { error } = payload as { error?: unknown };
  return typeof error === "string" && error.trim().length > 0 ? error : null;
}

function stripHtml(text: string): string {
  return text
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}
