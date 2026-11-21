import { z } from "zod";

function base64UrlDecode(input: string): string {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  return atob(padded);
}

/** One RSA JWKS entry, with the JWK fields importKey reads. importKey checks their values. */
const accessCertSchema = z.object({
  kid: z.string().optional(),
  kty: z.string(),
  n: z.string().optional(),
  e: z.string().optional(),
  alg: z.string().optional(),
  use: z.string().optional(),
  key_ops: z.array(z.string()).optional(),
  ext: z.boolean().optional(),
});
type AccessCert = z.infer<typeof accessCertSchema>;
const accessCertsSchema = z.object({ keys: z.array(accessCertSchema).min(1) });

/**
 * Only RS256, the algorithm verified below. Rejecting anything else closes the classic
 * "alg confusion" downgrade (e.g. `none`/HS256).
 */
const jwtHeaderSchema = z.object({ kid: z.string().min(1), alg: z.literal("RS256") });

const jwtPayloadSchema = z.object({
  email: z.string().optional(),
  common_name: z.string().optional(),
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  exp: z.number().optional(),
});
type AccessJwtPayload = z.infer<typeof jwtPayloadSchema>;

function decodeSegment<T>(segment: string, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(JSON.parse(base64UrlDecode(segment)));
  return parsed.success ? parsed.data : null;
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

let cachedCerts: { keys: AccessCert[]; fetchedAt: number } | null = null;
const CERTS_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchCerts(
  teamDomain: string,
): Promise<{ keys: AccessCert[]; fetchedAt: number } | null> {
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) return null;

  const body = accessCertsSchema.safeParse(await res.json());
  if (!body.success) return null;
  cachedCerts = { keys: body.data.keys, fetchedAt: Date.now() };
  return cachedCerts;
}

async function getAccessCerts(
  teamDomain: string,
  forceRefresh = false,
): Promise<{ keys: AccessCert[] } | null> {
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

/** The signing key for `kid`, refreshing the JWKS once when a rotation is not cached yet. */
async function findSigningKey(teamDomain: string, kid: string): Promise<AccessCert | null> {
  const cached = await getAccessCerts(teamDomain);
  const jwk = cached?.keys.find((key) => key.kid === kid);
  if (jwk || !cached) return jwk ?? null;
  const refreshed = await getAccessCerts(teamDomain, true);
  return refreshed?.keys.find((key) => key.kid === kid) ?? null;
}

async function hasValidSignature(parts: string[], jwk: AccessCert): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBytes = Uint8Array.from(base64UrlDecode(parts[2]), (c) => c.charCodeAt(0));
  const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes, dataBytes);
}

/** exp, aud and iss, checked after the signature. */
function hasValidClaims(
  payload: AccessJwtPayload,
  config: AccessConfig,
  teamDomain: string,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  // Reject on or after exp (RFC 7519: the token must not be accepted at/after exp).
  if (payload.exp === undefined || payload.exp <= now) return false;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return aud.includes(config.aud) && payload.iss === teamDomain;
}

function identityOf(payload: AccessJwtPayload, config: AccessConfig): AccessIdentity | null {
  if (payload.email) {
    // Case-insensitive: identity providers may return mixed-case local parts. The
    // lowercased email is returned so attribution (Sentry.setUser) stays stable: the same
    // identity in mixed case must not create duplicate users.
    const email = payload.email.toLowerCase();
    return config.allowedEmailDomains.some((d) => email.endsWith(`@${d}`))
      ? { kind: "user", email }
      : null;
  }
  // No email: an Access service token mints a non-identity app JWT carrying the token's
  // client ID as `common_name`. Only explicitly allowlisted client IDs pass.
  const clientId = payload.common_name;
  return clientId && config.allowedServiceTokenIds?.includes(clientId)
    ? { kind: "service", clientId }
    : null;
}

async function verifyInner(jwt: string, config: AccessConfig): Promise<AccessIdentity | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;

  // Normalize a trailing slash on the configured team domain. Access `iss` claims and
  // the JWKS path carry none, so "https://team.cloudflareaccess.com/" would otherwise
  // fail the issuer check for every token (and double-slash the certs URL).
  const teamDomain = config.teamDomain.replace(/\/+$/, "");

  const header = decodeSegment(parts[0], jwtHeaderSchema);
  if (!header) return null;
  const jwk = await findSigningKey(teamDomain, header.kid);
  if (!jwk || !(await hasValidSignature(parts, jwk))) return null;

  const payload = decodeSegment(parts[1], jwtPayloadSchema);
  if (!payload || !hasValidClaims(payload, config, teamDomain)) return null;
  return identityOf(payload, config);
}
