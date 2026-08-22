# Telemetry

How this Worker reports to Sentry, and how to query it. Sentry project
`4511179029020672` (org `sentry-developer-experience`).

Telemetry only runs when a `SENTRY_DSN` secret is set on the deployment
(`wrangler secret put SENTRY_DSN`). The DSN is deliberately not in the repo: this is a
public codebase, and a hardcoded DSN made every third-party deployment report into our
project — re-opening resolved issues with errors from stale forks. Unset means the SDK
is disabled, which is the right default for forks and self-hosters.

## The model

This is a **public** endpoint, so most requests aren't users — uptime monitors and
internet vulnerability scanners hit it constantly. Two rules keep the signal clean:

1. **Count with metrics, debug with spans.** Volume, status mix, and client mix come
   from the `app.server.response` **counter**, not from grouping raw spans. Metrics are
   cheap and bounded, so we can aggressively drop noise spans without losing dashboards.
2. **Every dimension is bounded.** Client attribution is a fixed-set *family* derived
   from the User-Agent, never the caller-controlled `mcp.client.name`. Routes are
   normalized templates. A scanner or monitor can't invent a new dimension value.

Config lives in `sentryConfig()` and the fetch handler in `src/worker.ts`; the pure
classification/bucketing logic is in `src/telemetry.ts` (unit-tested in
`__tests__/telemetry.test.ts`).

## What we emit

### Metric: `app.server.response` (counter, one per tracked request)

Recorded for `/mcp` and `/internal` only — untracked scanner paths are skipped so their
volume never enters dashboards. All attributes are low-cardinality:

| Attribute | Meaning | Example values |
| --- | --- | --- |
| `http.request.method` | HTTP method | `POST`, `GET` |
| `http.route` | Normalized route | `/mcp`, `/internal` |
| `app.route.group` | Route family | `mcp`, `internal` |
| `http.response.status_code` | Final status | `200`, `401`, `429` |
| `app.response.status_class` | Status bucket | `2xx`, `4xx`, `5xx` |
| `app.client.family` | Bucketed client (see below) | `claude-code`, `cursor`, `codex`, `mcp-remote`, `claude`, `openai`, `python`, `node`, `go`, `java`, `other`, `unknown` |
| `mcp.method.name` | Protocol method from a fixed allow-list | `server/discover`, `initialize`, `tools/call`, `other`, `unknown` |
| `app.mcp.request.kind` | Bounded request classification | `heartbeat`, `tool_call`, `control`, `unknown` |

### Metric: `mcp.tool.error` (counter, one per failed tool call)

Tool failures are returned to MCP clients as `isError: true` inside a successful JSON-RPC
response, so the outer HTTP status is normally 200. This counter preserves visibility without
turning expected caller failures into exception issues:

| Attribute | Meaning | Example values |
| --- | --- | --- |
| `mcp.tool.name` | Fixed registered tool name | `get_timeseries`, `compare_periods` |
| `error.kind` | Bounded failure category | `user_input`, `plausible_api`, `unexpected` |
| `http.response.status_code` | Plausible status, when applicable | `400`, `401`, `429`, `503` |

Unexpected failures and Plausible 5xx responses are also captured as exceptions. User input
failures and Plausible 4xx responses remain visible through this metric only.

### Span attributes (stamped on the root `http.server` span, tracked routes only)

`http.route`, `app.route.group`, `app.client.family`, `mcp.method.name`, and
`app.mcp.request.kind` — so real tool-call traces are groupable by a bounded client family
instead of the caller-controlled `mcp.client.name`, while HTTP roots can be sampled together
with their separately-exported MCP child transactions. Modern requests are classified from
the `Mcp-Method` header; legacy requests fall back to small JSON request clones. Neither path
retains request ids, params, tool arguments, or unknown method names.

### Client family

`resolveClientFamily(User-Agent)` buckets into the fixed set above. We use the
User-Agent, not the MCP `clientInfo.name`, because the latter is a free-form string a
monitor or scanner controls (`healthcheck`, `openclaw-bundle-mcp`). In the legacy era it
only rides `initialize`; in the modern era it rides every request and is copied from the
request envelope onto attributed `/internal` tool spans for per-trace deep dives. Anonymous
BYOK events strip it along with other caller-controlled identity. It remains a secondary
debugging attribute, never a dashboard dimension.

## Span noise dropped before send

Most of this happens in `beforeSendTransaction`; the rate limiter is the exception.

- **The rate limiter binding span** is dropped by the `ignoreSpans` option, matched on the
  `sentry.origin` attribute rather than the span name, which embeds the binding name.
  `@sentry/cloudflare` wraps any binding exposing `limit()` and times the call but records no
  outcome, so an allowed request and a throttled one produce identical spans. `beforeSendSpan`
  cannot drop it — returning `null` there only logs a warning and keeps the span. 429s stay
  visible through `app.server.response`.
- **Untracked routes** (`/.env`, `/wp-admin/*`, `/`, `favicon.ico`, …): dropped entirely.
- **`server/discover`, `ping`, `tools/list`, and healthcheck `initialize`**: sampled to
  `HEARTBEAT_SPAN_KEEP_RATE` (1%) — a thin heartbeat in Trace Explorer without the flood.
  Sampling is deterministic from the trace id, so the outer HTTP root and MCP child are
  kept or dropped together rather than producing empty roots or orphan children.
- **`notifications/initialized` and `notifications/roots/list_changed`**: dropped entirely.
  These are handshake bookkeeping and a roots capability notification the server does not
  implement, so neither has per-request debugging value.
- **Metrics remain complete**: the `app.server.response` metric counts 100% of sampled and
  dropped protocol requests, including `mcp.method.name` and `app.mcp.request.kind`, so
  uptime, volume, and method dashboards are unaffected.
- **Errors are separate events** routed through `beforeSend`. Two expected MCP transport
  rejections are dropped as issue noise: the 406 raised when a GET client does not accept
  `text/event-stream`, and the `Parse error` raised when a POST body is not valid JSON-RPC
  (scanners and curl probes; the transport already answers 400 itself). Both HTTP responses
  are still counted by `app.server.response`. Other error events are retained.

## Privacy

`/mcp` (BYOK) stays anonymous. Several mechanisms cover it, because the SDK captures some
data before any hook runs and routes feedback events around `beforeSend` entirely:

- **Request bodies and headers are never captured**, at the integration level rather than a
  hook. `sentryConfig()` overrides the default `httpServerIntegration` with
  `maxRequestBodySize: "none"` and the default `requestDataIntegration` with everything
  (`headers`, `data`, `cookies`, `ip`, `query_string`) turned off. This matters because
  `sendDefaultPii: false` gates neither: without this override, the SDK captures the raw
  request body — on `/mcp` that's the caller's JSON-RPC envelope, whose `params._meta` carries
  whatever their client volunteers (end-user coordinates, filesystem paths, stable subject
  ids seen in the wild) — onto every event regardless.
- **Caller-controlled request span attributes are stripped.** `stripRequestAttributes`
  (`src/redaction.ts`) runs unconditionally, called from both `anonymizeEventWithoutEmail` (for
  `contexts.trace.data` and `spans[].data` on `beforeSend`/`beforeSendTransaction` events) and
  `beforeSendSpan` (for span data — the only thing that hook can reach). It removes:
  - The whole `http.request.header.*`/`http.response.header.*` namespace. `@sentry/cloudflare`
    turns every HTTP header into one of these, filtered only by substring match against its own
    sensitive-key list — which misses client-specific identity headers like `x-openai-subject`.
  - `user_agent.original`, free-form caller text that duplicates no signal `mcp.client.name`
    does not already carry.
  - `url.query`, and the query and fragment on `url.full`. `requestDataIntegration`'s
    `query_string: false` does not reach these, and neither endpoint reads the query string.
    `url.path` survives as the routing signal. `anonymizeEventWithoutEmail` applies the same
    trim to `request.url`.
- **`beforeSend` and `beforeSendTransaction`** both call `anonymizeEventWithoutEmail`
  (`src/redaction.ts`), which always filters `Authorization`/`Cookie`/`Cf-Access-Jwt-Assertion`
  out of request headers, and — on any event without an email — replaces the user with an
  explicitly IP-less object and deletes the JSON-RPC request body.
- **Feedback events bypass `beforeSend`.** `Sentry.captureFeedback` produces `type: "feedback"`
  events, which `beforeSend` never sees, so `send_feedback` (`src/tools/send-feedback.ts`)
  attaches `anonymizeEventWithoutEmail` directly as a scope event processor around the call.
- **`mcp.client.name` and `mcp.client.version` are recorded on both endpoints.** A client
  library name and version identify software, not a person, so they're deliberately exempt
  from anonymization — unlike `mcp.client.title`, a free-form display string a client chooses
  that may contain a person's or workspace's name, which is never recorded (see
  `src/mcp-telemetry.ts`).
- Only `/internal` attaches `Sentry.setUser({ email })` and records tool I/O, remaining
  attributed to the authenticated user. The `app.client.family` attribute is a bounded bucket,
  not PII.

## Query recipes

Response volume by route and status (metrics):

```text
dataset=tracemetrics query='metric:app.server.response'
aggregate=sum(value) by http.route,app.response.status_class
```

Traffic by client family (the fixed dashboard):

```text
dataset=tracemetrics query='metric:app.server.response app.route.group:mcp'
aggregate=sum(value) by app.client.family
```

Rate-limit pressure by client:

```text
dataset=tracemetrics query='metric:app.server.response http.response.status_code:429'
aggregate=sum(value) by app.client.family
```

Real tool calls (spans — noise already sampled out):

```text
dataset=spans query='span.op:mcp.server span.description:"tools/call*"'
fields=timestamp,trace,span.description,mcp.client.name,mcp.method.name
sort=-timestamp
```

`app.client.family` is not available here: it is stamped on the `http.server` root span, not
on this `mcp.server` child (see "Span attributes"). Join through `trace` to reach it, or group
by client with the metric recipes above. `mcp.client.name` is caller-controlled — fine for
eyeballing a trace, not for a dashboard dimension.

## Future pillar

Structured **logs** (`enableLogs` + `Sentry.logger`) are the natural next addition —
e.g. a line on `/internal` 403s and on Plausible upstream non-2xx responses, queryable by
`trace_id`. Not enabled yet: we only add pillars with real call sites rather than an empty
integration.
