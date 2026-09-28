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
with their MCP child segments. Modern requests are classified from
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

## Span sampling at request start

SDK v11 streams spans individually: once a span starts, nothing can drop it —
`beforeSendSpan` may only edit, and returning `null` there only logs a warning and keeps the
span. So every noise rule that used to inspect a finished transaction is now a sampling rate
decided when the root span starts, in `tracesSampler` (`rootSampleRate` in `src/telemetry.ts`).
`tracesSampler` runs with `normalizedRequest` (url, method, lower-cased header keys) and, for
a span with a parent, `parentSampled`; the MCP child segment inherits its parent's decision
through `parentSampled`, so root and child are kept or dropped together rather than producing
empty roots or orphan children. Legacy requests (no `Mcp-Method` header) would otherwise be
unclassifiable at sampler time — before the handler even runs — so `withMcpMethodHeader` in
`src/worker.ts` synthesizes the header from a bounded clone of the body ahead of
`Sentry.withSentry`, copying only known method names.

**The rate limiter binding span** is dropped by the `ignoreSpans` option, matched on the
`sentry.origin` attribute rather than the span name, which embeds the binding name.
`@sentry/cloudflare` wraps any binding exposing `limit()` and times the call but records no
outcome, so an allowed request and a throttled one produce identical spans. `beforeSendSpan`
cannot drop it — returning `null` there only logs a warning and keeps the span. 429s stay
visible through `app.server.response`.

Rates:

- **Untracked routes** (`/.env`, `/wp-admin/*`, `/`, `favicon.ico`, …): 0%.
- **Sub-paths of a tracked route with no MCP metadata** (`/mcp/actuator/heapdump`,
  `/internal/backup.tar.gz`): 0%. Protocol traffic lives on the endpoint itself,
  so a deeper path without a method attribute is a scanner probing a directory that looks real.
  The `app.server.response` metric still counts them under the tracked route.
- **`ping`, `server/discover`, `tools/list`, and `initialize`**: sampled to
  `HEARTBEAT_SPAN_KEEP_RATE` (1%) — a thin heartbeat in Trace Explorer without the flood.
  Every `initialize` counts, not only the uptime monitor's: the client name that used to
  single it out lives in the body, which the sampler cannot read, and a real session's
  signal is in its tool calls, which stay at 100%.
- **`notifications/initialized` and `notifications/roots/list_changed`**: 0%.
  These are handshake bookkeeping and a roots capability notification the server does not
  implement, so neither has per-request debugging value. `notifications/cancelled` is kept:
  it marks a client abandoning an in-flight request, which is a signal when tool latency is
  under investigation.
- **Everything else** (real tool calls, reads, unknown methods, the endpoint with no method
  header yet): 100%.
- **Metrics remain complete**: the `app.server.response` metric counts 100% of sampled and
  dropped protocol requests, including `mcp.method.name` and `app.mcp.request.kind`, so
  uptime, volume, and method dashboards are unaffected.
- **Errors are separate events** routed through `beforeSend`. Two expected MCP transport
  rejections are dropped as issue noise: the 406 raised when a GET client does not accept
  `text/event-stream`, and the parse failure raised when a POST body is not valid JSON-RPC
  (scanners and curl probes; the transport already answers 400 itself). The transport reports
  that failure either as a wrapped `Parse error` message or, since MCP SDK 2.1, as the raw
  `SyntaxError` from `JSON.parse`, and both forms are dropped. Both HTTP responses
  are still counted by `app.server.response`. Other error events are retained.

## Privacy

`/mcp` (BYOK) stays anonymous. Several mechanisms cover it, because the SDK captures some
data before any hook runs and routes feedback events around `beforeSend` entirely:

- **Request bodies and headers are never captured**, at the integration level rather than a
  hook. `sentryConfig()` overrides the default `httpServerIntegration` with
  `maxRequestBodySize: "none"` and the default `requestDataIntegration` with everything
  (`headers`, `data`, `cookies`, `ip`, `query_string`) turned off. This matters because
  `dataCollection` (every category off) is not trusted to gate either: without this override, the SDK captures the raw
  request body — on `/mcp` that's the caller's JSON-RPC envelope, whose `params._meta` carries
  whatever their client volunteers (end-user coordinates, filesystem paths, stable subject
  ids seen in the wild) — onto every event regardless.
- **Caller-controlled request span attributes are stripped.** `stripRequestAttributes`
  (`src/redaction.ts`) runs unconditionally, called from both `anonymizeEventWithoutEmail` (for
  `contexts.trace.data` and `spans[].data` on `beforeSend` error events) and `beforeSendSpan`
  (for `attributes` on every streamed span). `beforeSendSpan` also removes every `user.*`
  attribute from a segment span (root or MCP child) that has no `user.email` — the SDK derives
  `user.*` itself, and only `/internal` attaches an identified user, so it must never ride an
  anonymous `/mcp` span. It removes:
  - The whole `http.request.header.*`/`http.response.header.*` namespace. `@sentry/cloudflare`
    turns every HTTP header into one of these, filtered only by substring match against its own
    sensitive-key list — which misses client-specific identity headers like `x-openai-subject`.
  - `user_agent.original`, free-form caller text that duplicates no signal `mcp.client.name`
    does not already carry.
  - `mcp.client.title`. `recordMcpClientInfo` never sets it, but a legacy client sends
    `clientInfo` through the `initialize` handshake, which the SDK stores per transport and
    writes onto spans itself — so suppressing it at our own call site is not enough.
  - `url.query`, and the query and fragment on `url.full`. `requestDataIntegration`'s
    `query_string: false` does not reach these, and neither endpoint reads the query string.
    `url.path` survives as the routing signal. `anonymizeEventWithoutEmail` applies the same
    trim to `request.url`.
- **`beforeSend`** calls `anonymizeEventWithoutEmail`
  (`src/redaction.ts`), which always filters `Authorization`/`Cookie`/`Cf-Access-Jwt-Assertion`
  out of request headers, and — on any event without an email — replaces the user with an
  explicitly IP-less object and deletes the JSON-RPC request body.
- **Feedback events bypass `beforeSend`.** `Sentry.captureFeedback` produces `type: "feedback"`
  events, which `beforeSend` never sees, so `send_feedback` (`src/tools/send-feedback.ts`)
  attaches `anonymizeEventWithoutEmail` directly as a scope event processor around the call.
- **`mcp.client.name` and `mcp.client.version` are recorded on both endpoints, sanitized.** A
  client library name and version identify software, not a person, so they're deliberately
  exempt from anonymization — unlike `mcp.client.title`, a free-form display string a client
  chooses that may contain a person's or workspace's name. `src/mcp-telemetry.ts` never sets
  it and `stripRequestAttributes` removes it if the SDK does.

  Both surviving fields still pass through `sanitizeClientAttribute` (`src/redaction.ts`),
  applied where `recordMcpClientInfo` writes them *and* inside `stripRequestAttributes`, which
  is what catches the SDK's own legacy-handshake write. A value carrying an email, a URL, an
  absolute or Windows path, a UUID or long hex id, or a trailing hostname is replaced whole
  with `[redacted]`; anything else is trimmed to 64 characters. Replacing the whole value
  rather than masking part of it avoids leaking the surrounding context and avoids turning one
  bad value into many distinct ones. Reverse-DNS names (`io.modelcontextprotocol.inspector`)
  and scoped names (`@scope/pkg`) survive, because the hostname rule anchors to the end of a
  token and the path rule keys on a slash no word character precedes.

  This is a failsafe against the shapes that leak by accident, not a guarantee — a caller who
  writes a person's name in prose still gets it through. Only an allow-list would close that,
  at the cost of dropping every client we have not seen. The field remains a per-trace
  debugging attribute; `app.client.family` stays the dashboard dimension.
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
