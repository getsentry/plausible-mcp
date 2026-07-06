function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  return atob(padded);
}

interface AccessJwtPayload {
  email?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
}

export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

let cachedCerts: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const CERTS_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchCerts(
  teamDomain: string,
): Promise<{ keys: JsonWebKey[]; fetchedAt: number } | null> {
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) return null;

  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys) || body.keys.length === 0) return null;
  cachedCerts = { keys: body.keys as JsonWebKey[], fetchedAt: Date.now() };
  return cachedCerts;
}

async function getAccessCerts(
  teamDomain: string,
  forceRefresh = false,
): Promise<{ keys: JsonWebKey[] } | null> {
  if (!forceRefresh && cachedCerts && Date.now() - cachedCerts.fetchedAt < CERTS_CACHE_TTL_MS) {
    return cachedCerts;
  }
  return await fetchCerts(teamDomain) ?? cachedCerts;
}

export function clearCertsCache(): void {
  cachedCerts = null;
}

export async function verifyCloudflareAccessJwt(
  jwt: string,
  config: AccessConfig,
): Promise<{ email: string } | null> {
  try {
    return await verifyInner(jwt, config);
  } catch {
    // Fail closed: a malformed segment (bad base64/JSON), a JWKS fetch error, or any
    // other unexpected throw must surface as "not authorized" (caller returns 403),
    // never as an uncaught 500. The upstream id_token from /callback flows through here.
    return null;
  }
}

async function verifyInner(
  jwt: string,
  config: AccessConfig,
): Promise<{ email: string } | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;

  let certs = await getAccessCerts(config.teamDomain);
  if (!certs) return null;

  const header = JSON.parse(base64UrlDecode(parts[0])) as {
    kid?: string;
    alg?: string;
  };
  if (!header.kid) return null;
  // Only accept RS256 — the algorithm we actually verify below. Rejecting anything
  // else closes the classic "alg confusion" downgrade (e.g. `none`/HS256) vector.
  if (header.alg !== "RS256") return null;

  let jwk = certs.keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk) {
    certs = await getAccessCerts(config.teamDomain, true);
    if (!certs) return null;
    jwk = certs.keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === header.kid);
    if (!jwk) return null;
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signatureBytes = Uint8Array.from(
    base64UrlDecode(parts[2]),
    (c) => c.charCodeAt(0),
  );
  const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signatureBytes,
    dataBytes,
  );
  if (!valid) return null;

  const payload = JSON.parse(base64UrlDecode(parts[1])) as AccessJwtPayload;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp == null || payload.exp < now) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(config.aud)) return null;

  if (!payload.iss || payload.iss !== config.teamDomain) return null;

  const email = payload.email;
  // Case-insensitive: identity providers may return mixed-case local parts.
  if (!email || !email.toLowerCase().endsWith("@sentry.io")) return null;

  return { email };
}
