export function pronoteLog(message: string, details?: Record<string, unknown>): void {
  console.log(`[PRONOTE] ${new Date().toISOString()} ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

// Host and path only: query strings can carry SSO tickets and SAML payloads.
export function safeTarget(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export type PronoteSsoCapture = { url: string; username: string; token: string; uuid: string };

// Pronote's own web app id, as used by the mobile applications.
export const PRONOTE_MOBILE_APP_ID = "0D264427-EEFC-4810-A9E9-346942A862A4";

export function pronoteBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    const index = parsed.pathname.toLowerCase().indexOf("/pronote");
    if (parsed.protocol !== "https:" || index < 0) return null;
    return `${parsed.origin}${parsed.pathname.slice(0, index + "/pronote".length)}`;
  } catch {
    return null;
  }
}
