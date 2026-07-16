# Telemetry

How this Worker reports to Sentry, and how to query it. Sentry project
`4511179029020672` (org `sentry-developer-experience`).

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
| `mcp.method.name` | Protocol method from a fixed allow-list | `ping`, `initialize`, `tools/call`, `other`, `unknown` |
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
instead of the initialize-only `mcp.client.name`, while HTTP roots can be sampled together
with their separately-exported MCP child transactions. The Worker parses only small JSON
request clones and retains no request ids, params, tool arguments, or unknown method names.

### Client family

`resolveClientFamily(User-Agent)` buckets into the fixed set above. We use the
User-Agent, not the MCP `clientInfo.name`, because the latter (a) only rides the
`initialize` message — every follow-up ping/tool call on this stateless per-request
server would otherwise be `(no value)` — and (b) is a free-form string a monitor or
scanner controls (`healthcheck`, `openclaw-bundle-mcp`). The raw `mcp.client.name` is
still on `initialize` spans for per-trace deep dives; it's just not a dashboard dimension.

## Span noise dropped before send (`beforeSendTransaction`)

- **Untracked routes** (`/.env`, `/wp-admin/*`, `/`, `favicon.ico`, …): dropped entirely.
- **`ping` and healthcheck `initialize`**: sampled to `HEARTBEAT_SPAN_KEEP_RATE` (1%) —
  a thin heartbeat in Trace Explorer without the flood. Sampling is deterministic from the
  trace id, so the outer HTTP root and separately-exported MCP child are kept or dropped
  together rather than producing empty roots or orphan children. The `app.server.response`
  metric still counts 100% of them, so uptime/volume is unaffected.
- **Errors are separate events** routed through `beforeSend`. The expected MCP 406 raised when
  a GET client does not accept `text/event-stream` is dropped as issue noise; its HTTP response
  is still counted by `app.server.response`. Other error events are retained.

## Privacy (unchanged)

`/mcp` (BYOK) stays anonymous: `beforeSend` strips both the ingest-inferred IP and any
JSON-RPC request body from events without an email (`src/redaction.ts`),
`beforeSendTransaction` applies the same identity guardrail, and `beforeSendSpan` filters
`Authorization`/`Cookie`/`Cf-Access-Jwt-Assertion` span data. Only `/internal` attaches
`Sentry.setUser({ email })` and records tool I/O. The `app.client.family` attribute is a
bounded bucket, not PII.

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

Real tool calls, grouped by client (spans — noise already sampled out):

```text
dataset=spans query='span.op:mcp.server span.description:"tools/call*"'
fields=timestamp,trace,span.description,app.client.family,mcp.method.name
sort=-timestamp
```

## Future pillar

Structured **logs** (`enableLogs` + `Sentry.logger`) are the natural next addition —
e.g. a line on `/internal` 403s and on Plausible upstream non-2xx responses, queryable by
`trace_id`. Not enabled yet: we only add pillars with real call sites rather than an empty
integration.
