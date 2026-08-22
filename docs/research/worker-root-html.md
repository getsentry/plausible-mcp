# Serving HTML at the Worker root without breaking `/mcp` or `/internal`

Research for [#43](https://github.com/getsentry/plausible-mcp/issues/43) (part of the
[#42](https://github.com/getsentry/plausible-mcp/issues/42) landing-page map). Answers two
questions: how the Worker serves a landing page at `/`, and how Cloudflare Access is scoped so
`/` is public while `/internal` stays gated.

## Summary of the recommendation

1. **Serve the page as an inline HTML string from `src/worker.ts`.** No `[assets]` binding, no
   committed asset directory, no wrangler change.
2. **Leave `classifyRoute` untouched.** `/` stays untracked, so the public page records no
   metrics and its transactions are dropped — the `TELEMETRY.md` posture holds with no new code.
3. **Move the Managed OAuth Access application off the apex hostname onto its own hostname**
   (e.g. `connect.plausible-mcp.sentry.dev`), pointed at the same Worker via a second custom
   domain. `plausible-mcp.sentry.dev` then carries no Access application at all, so `/` and
   `/mcp` are publicly reachable, and the `/mcp` Bypass application can be deleted.

Point 3 is forced, not preferred. See "Why the root cannot be carved out".

## 1. What the repo does today

`src/worker.ts` (`handler.fetch`, end of file) routes purely on `pathname`:

| Path | Handling |
| --- | --- |
| `OPTIONS` (any path) | `204` + CORS |
| `/internal`, `/internal/*` | `handleInternalMcp` |
| `/mcp`, `/mcp/*` | `handleDirectMcp` |
| everything else, **including `/`** | `jsonError("Not found.", 404)` |

Every response is wrapped by `corsResponse()`, which sets `Access-Control-Allow-Origin: *`,
`Cache-Control: no-store`, `X-Frame-Options: DENY` and the rest of `SECURITY_HEADERS`.

`classifyRoute` (`src/telemetry.ts:126`) returns `null` for `/`. With `tracked === null` the
Worker skips `mcpRequestValidationResponse` (no Host/Origin check), skips `inspectMcpRequest`,
stamps no `http.route` / `app.route.group` / `app.client.family` span attributes, and
`recordResponseMetric` early-returns. `transactionDropReason` (`src/telemetry.ts:316`) then drops
the transaction with reason `untracked-route`. **A landing page at `/` is invisible to telemetry
by default** — which is exactly the posture `TELEMETRY.md` asks for on an anonymous public route.

`rateLimited()` runs on *every* path, tracked or not, keyed on `CF-Connecting-IP` at 60 requests
per 60 seconds (`wrangler.toml`, `[[unsafe.bindings]] RATE_LIMITER`).

The deployed Access topology is documented in README "Self-Hosting":

- **App 1** — Managed OAuth, self-hosted, domain `plausible-mcp.sentry.dev` **with no path**. A
  path is impossible here: Cloudflare rejects it with
  `access.api.error.invalid_request: domain can not have a path if oauth is configured`.
- **App 2** — self-hosted, domain `plausible-mcp.sentry.dev` **path `mcp`**, Managed OAuth off,
  one policy with Action `Bypass` and selector `Everyone`. This carves the BYOK endpoint back out
  from under App 1.

So `/` is inside App 1 today. The `401 invalid_token` the ticket reports is Access, before the
Worker runs; the Worker's own `404` is only what an authenticated request would see.

## 2. Why the root cannot be carved out with a third Access app

Access path scoping is documented at
<https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/>:

- An empty **Path** covers the apex *and* every subpath. `example.com` and `example.com/*` are
  equivalent and both cover `example.com`, `example.com/alpha`, `example.com/beta`.
- `example.com/alpha/*` covers `example.com/alpha/one` but **not** `example.com/alpha` itself.
- Partial wildcards are allowed (`example.com/foo*/bar`), at most one `*` between slashes.
- Precedence, verbatim: "When multiple rules are set for a common root path, the more specific
  rule takes precedence."

There is no syntax for "match exactly `/` and nothing below it". Any application that would match
`/` matches the whole hostname, which is the same domain+path as the Managed OAuth application —
not a *more specific* rule that could win precedence, and a duplicate of an app that already
exists on that hostname. The `/mcp` Bypass app works precisely because `mcp` is a strictly more
specific path; `/` has no such handle.

Combined with the Managed OAuth constraint (App 1 *must* own the bare hostname), the conclusion
is structural: **while a Managed OAuth application sits on `plausible-mcp.sentry.dev`, nothing at
`/` on that hostname can be made public.**

## 3. The way out: give Managed OAuth its own hostname

Access enforcement is per hostname+path, so the fix is to stop making `/internal`'s OAuth front
door own the apex.

- Add a second custom domain to the same Worker, e.g. `connect.plausible-mcp.sentry.dev`.
- Re-point App 1 (Managed OAuth) at that hostname, no path. Editing the existing application
  keeps its AUD, so `CF_ACCESS_AUD` is unchanged; creating a new one means copying a new AUD.
- Delete App 2 — with no Access app on the apex, `/mcp` needs no Bypass carve-out.
- Update the managed connector (Cowork / Claude.ai) URL to
  `https://connect.plausible-mcp.sentry.dev/internal`, and its Access allowed redirect URIs are
  unchanged (`https://claude.ai/api/mcp/auth_callback`).

Result: `plausible-mcp.sentry.dev/` and `/mcp` are publicly reachable with no Access involvement;
`/internal` is reachable only through the OAuth hostname. Net Access complexity goes **down**,
from two overlapping applications to one.

### Is `/internal` still safe on the unprotected apex?

Yes, and this is the load-bearing point. Access was never the authorization gate for `/internal`
— `handleInternalMcp` fails closed with `403` when `Cf-Access-Jwt-Assertion` is absent, and
`src/cf-access.ts` verifies the assertion's RS256 signature against the team JWKS plus
`iss`/`aud`/`exp` and the `ALLOWED_EMAIL_DOMAIN` gate. An unauthenticated request to
`https://plausible-mcp.sentry.dev/internal` gets a `403` from the Worker, not data. Access
coverage of `/internal` exists to run the OAuth 2.1 handshake, not to authorize requests.

Optional belt-and-braces: have the `/internal` branch return the standard `404` unless
`url.hostname` is the OAuth hostname. Cheap, but not required for correctness.

### Cost

- One DNS record / custom domain, one `routes` entry, one line in `MCP_ALLOWED_HOSTNAMES`.
- A connector URL change for existing `/internal` users — the only user-visible breakage. Existing
  OAuth grants are tied to the old resource identifier and will need re-authorization.
- README "Self-Hosting" needs rewriting: the two-app dance becomes one app on a subdomain.

### Rejected alternatives

- **Landing page at `/home` with a Bypass app.** Works today with zero Access risk, but #42 states
  the page lives at the root of the existing Worker. A `/` that still 401s undercuts the install
  funnel.
- **Landing page on a separate hostname.** Same objection: #42 says same origin is deliberate.
- **Third Bypass app on the apex.** Not creatable — see section 2.

## 4. Serving the HTML: inline string, not `[assets]`

### Recommended: inline

Add before the 404 fallback in `src/worker.ts`:

```ts
} else if (pathname === "/") {
  return new Response(LANDING_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      ...SECURITY_HEADERS,
    },
  });
}
```

Returning directly (rather than assigning `response` and falling through) skips `corsResponse()`,
which would otherwise force `Cache-Control: no-store` and `Access-Control-Allow-Origin: *` onto an
HTML document that wants neither. It also skips `recordResponseMetric`, which for an untracked
route is already a no-op.

Nothing else changes: no `wrangler.toml` edit, no new binding, no `tsconfig` edit. `worker.ts`
stays excluded from `pnpm build`'s `tsconfig.json` and covered by `tsconfig.worker.json` exactly
as now. The HTML counts toward the Worker bundle size, which only matters at hundreds of KB.

### Considered: the `assets` binding

Keys and defaults, from <https://developers.cloudflare.com/workers/wrangler/configuration/>:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `directory` | string | — | folder of static assets to serve |
| `binding` | string | — | binding name (`env.ASSETS`), useful only when `main` is set |
| `run_worker_first` | boolean \| string[] | `false` | whether assets are fetched directly or the Worker runs first; array form takes globs with `!` exceptions, each starting `/` or `!/` |
| `html_handling` | string | `auto-trailing-slash` | also `force-trailing-slash`, `drop-trailing-slash`, `none` |
| `not_found_handling` | string | `none` | also `single-page-application`, `404-page` |

By default Cloudflare serves a matching static asset first and only invokes the Worker on a miss
(<https://developers.cloudflare.com/workers/static-assets/routing/worker-script/>).
`env.ASSETS.fetch(request)` returns an asset response with `html_handling` /
`not_found_handling` applied (<https://developers.cloudflare.com/workers/static-assets/binding/>).

Why it loses here:

- **The directory must exist at build time.** Verified against this repo's wrangler (4.115.0):
  `[assets] directory = "./public"` with no `public/` makes `wrangler deploy --dry-run` fail with
  `The directory specified by the "assets.directory" field in your configuration file does not
  exist`. So `public/` must be committed, not generated.
- **Assets-first routing bypasses the Worker entirely** for `/`, so the page gets no
  `SECURITY_HEADERS`, no rate limiting, and no Sentry transaction — and any accidental filename
  collision silently shadows a Worker route. Keeping the Worker authoritative means
  `run_worker_first = true` and calling `env.ASSETS.fetch(request)` yourself, at which point the
  binding has bought nothing over an inline string.
- **Assets do not escape Access.** Per
  <https://developers.cloudflare.com/workers/configuration/cloudflare-access/>: "Workers with
  Static Assets execute behind an internal router Worker. Access still protects the application
  and its assets. However, the router does not pass `ctx.access` to the user Worker." The binding
  solves none of the Access problem.
- One `Env` field (`ASSETS?: Fetcher` in `src/env.ts`, worker-tsconfig side only) plus a new
  committed directory, for one page.

`[assets]` earns its keep once there is CSS, images, or more than one page. Revisit then.

## 5. Telemetry

Leave `classifyRoute` alone. Adding a `landing` group would:

- start recording `app.server.response` metrics for anonymous browser traffic and keep its
  transactions in Sentry, which is the attribution `TELEMETRY.md` reserves for `/internal`; and
- switch on `mcpRequestValidationResponse` for `/`, enforcing the `MCP_ALLOWED_HOSTNAMES` Host
  allowlist on a page that has no reason to care.

Untracked is both the default and the right answer. If page-view counts are ever wanted, they
belong in Plausible (the product this server queries), not in Sentry.

## 6. Gotchas found

- **The rate limiter is shared.** 60 requests/minute per IP covers `/` and `/mcp` together. Keep
  the landing page a single self-contained HTML document (inline CSS, inline or omitted JS, no
  favicon fetch) or a page load will spend several of a visitor's tokens. If the page ever grows
  subresources, move the `rateLimited()` call behind the `tracked` check so it guards only the MCP
  endpoints.
- **Access runs before the Worker**, so nothing in `worker.ts` can make `/` public on a hostname
  an Access application covers. This is a dashboard change first, a code change second.
- **`Bypass` is not `Allow`.** README records the empirical failure: an `Allow` policy returns an
  HTML `302` to the login page, and MCP clients fail with `Unexpected content type: text/html`.
- **Bypass policies with device-posture checks break when a Worker intercepts the request**
  (<https://developers.cloudflare.com/cloudflare-one/access-controls/policies/>). The current
  `/mcp` bypass has no posture check, so it is unaffected — but do not add one.
- **Worker-level Access is all-or-nothing.** The one-click feature at
  <https://developers.cloudflare.com/workers/configuration/cloudflare-access/> "automatically
  protects every domain associated with the Worker, including its routes, Custom Domains,
  `workers.dev` hostname, and previews". It cannot express per-path scoping and must not be used
  here.
- **Green check** per `CLAUDE.md` is still all three: `pnpm build`, `pnpm typecheck`, `pnpm test`.

## 7. Minimal diff

- `src/worker.ts` — a `LANDING_HTML` const and a `pathname === "/"` branch returning it, before
  the 404 fallback.
- `src/telemetry.ts` — no change.
- `wrangler.toml` — add `{ pattern = "connect.plausible-mcp.sentry.dev", custom_domain = true }`
  to `routes`, and append that hostname to `MCP_ALLOWED_HOSTNAMES`.
- `__tests__/worker.test.ts` — one case asserting `GET /` returns `200` with
  `content-type: text/html; charset=utf-8`.
- `README.md` — rewrite "Self-Hosting" for one Access application on the OAuth subdomain; drop the
  `/mcp` Bypass step.
- Cloudflare dashboard — re-point the Managed OAuth app to the new hostname, delete the `/mcp`
  Bypass app, update the connector URL.

## Sources

- <https://developers.cloudflare.com/workers/static-assets/binding/>
- <https://developers.cloudflare.com/workers/static-assets/routing/worker-script/>
- <https://developers.cloudflare.com/workers/wrangler/configuration/>
- <https://developers.cloudflare.com/workers/configuration/cloudflare-access/>
- <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/>
- <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/>
- <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>
- <https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/>
- Repo: `src/worker.ts`, `src/telemetry.ts`, `src/cf-access.ts`, `src/env.ts`, `wrangler.toml`,
  `tsconfig.worker.json`, `TELEMETRY.md`, `README.md` "Self-Hosting"
