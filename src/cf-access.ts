function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  return atob(padded);
}

interface AccessJwtPayload {
  email?: string;
  common_name?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
}

export interface AccessConfig {
  teamDomain: string;
  aud: string;
  /**
   * Email domains allowed to authenticate, without the leading "@" (e.g.
   * ["sentry.io"]). The verified identity's email must end with one of these.
   * Defense in depth on top of the upstream Cloudflare Access policy.
   */
  allowedEmailDomains: string[];
  /**
   * Access service-token client IDs (e.g. "abc123.access") allowed in addition to
   * email identities. Service-token JWTs carry `common_name` instead of `email`, so
   * the email-domain gate cannot apply; each token must be listed here explicitly.
   * Unset/empty rejects all service tokens (fail closed).
   */
  allowedServiceTokenIds?: string[];
}

/**
 * The verified caller behind a Cloudflare Access assertion: a human who signed in
 * through an identity provider, or a machine using an Access service token.
 */
export type AccessIdentity =
  | { kind: "user"; email: string }
  | { kind: "service"; clientId: string };

/**
 * Parses the ALLOWED_EMAIL_DOMAIN env value (comma-separated, "@" optional) into a
 * normalized list. Defaults to ["sentry.io"] when unset/empty so the canonical hosted
 * deploy stays Sentry-only and self-hosters fail closed until they configure their own.
 */
export function parseAllowedEmailDomains(raw?: string): string[] {
  const domains = (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d.length > 0);
  return domains.length > 0 ? domains : ["sentry.io"];
}

/**
 * Parses the ALLOWED_SERVICE_TOKEN_IDS env value (comma-separated Access service-token
 * client IDs) into a normalized list. Unlike email domains there is no safe default:
 * unset/empty means no service token is accepted.
 */
export function parseAllowedServiceTokenIds(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
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
  // Fail closed once the cache is past its TTL: if the JWKS fetch fails we return null
  // (caller → 403) rather than fall back to stale keys, which could include a revoked
  // signing key. Cached keys are only ever trusted within the TTL checked above.
  return await fetchCerts(teamDomain);
}

export function clearCertsCache(): void {
  cachedCerts = null;
}

export async function verifyCloudflareAccessJwt(
  jwt: string,
  config: AccessConfig,
): Promise<AccessIdentity | null> {
  try {
    return await verifyInner(jwt, config);
  } catch {
    // Fail closed: a malformed segment (bad base64/JSON), a JWKS fetch error, or any
    // other unexpected throw must surface as "not authorized" (caller returns 403),
    // never as an uncaught 500. The Cf-Access-Jwt-Assertion header flows through here.
    return null;
  }
}

async function verifyInner(
  jwt: string,
  config: AccessConfig,
): Promise<AccessIdentity | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;

  // Normalize a trailing slash on the configured team domain. Access `iss` claims and
  // the JWKS path carry none, so "https://team.cloudflareaccess.com/" would otherwise
  // fail the issuer check for every token (and double-slash the certs URL).
  const teamDomain = config.teamDomain.replace(/\/+$/, "");

  let certs = await getAccessCerts(teamDomain);
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
    certs = await getAccessCerts(teamDomain, true);
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
  // Reject on or after exp (RFC 7519: the token must not be accepted at/after exp).
  if (payload.exp == null || payload.exp <= now) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(config.aud)) return null;

  if (!payload.iss || payload.iss !== teamDomain) return null;

  const email = payload.email;
  if (email) {
    // Case-insensitive: identity providers may return mixed-case local parts.
    const normalizedEmail = email.toLowerCase();
    if (!config.allowedEmailDomains.some((d) => normalizedEmail.endsWith(`@${d}`))) {
      return null;
    }

    // Return the normalized (lowercased) email so downstream attribution (Sentry.setUser)
    // is stable — the same identity in mixed case must not create duplicate users.
    return { kind: "user", email: normalizedEmail };
  }

  // No email: an Access service token mints a non-identity app JWT carrying the token's
  // client ID as `common_name`. Only explicitly allowlisted client IDs pass.
  const clientId = payload.common_name;
  if (clientId && config.allowedServiceTokenIds?.includes(clientId)) {
    return { kind: "service", clientId };
  }

  return null;
}
