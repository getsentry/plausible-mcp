# MCP Apps for plausible-mcp

Research for [#46](https://github.com/getsentry/plausible-mcp/issues/46), part of the landing-page map [#42](https://github.com/getsentry/plausible-mcp/issues/42). Resolved 2026-08-21.

**Answer: adopt MCP Apps. `get_timeseries` leads. Do not install `@modelcontextprotocol/ext-apps` on the Worker — hand-write the `_meta.ui` contract on `@modelcontextprotocol/server` 2.0.0, and use `ext-apps` only inside the browser bundle.**

Primary sources: the published package `@modelcontextprotocol/ext-apps@1.7.5` (its own `dist/**/*.d.ts`, `dist/src/generated/schema.json`, `package.json`, `README.md`), the normative spec text, and the installed `@modelcontextprotocol/server@2.0.0` type declarations in this repo. Package contents were read from the npm tarball; paths below are relative to the package root.

| Source | URL |
| --- | --- |
| SEP-1865 (Final, Extensions Track) | <https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp> |
| Normative spec, 2026-01-26 | <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx> |
| Normative spec, draft | <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx> |
| Overview and build guide | <https://modelcontextprotocol.io/extensions/apps/overview>, `/extensions/apps/build` |
| Client support matrix | <https://modelcontextprotocol.io/extensions/client-matrix> |
| Extension negotiation (core 2026-07-28) | <https://modelcontextprotocol.io/extensions/overview> |
| SDK API docs | <https://apps.extensions.modelcontextprotocol.io/api/> |

The extension identifier `io.modelcontextprotocol/ui` and the `ui://` scheme are both reserved in core MCP.

## 1. The server-side contract

### Tool metadata

A UI-bearing tool carries `_meta.ui` on its **tool definition** (`tools/list`), not on the tool result. `@modelcontextprotocol/server@2.0.0` already accepts this: `registerTool(name, config, cb)` where `config` includes `_meta?: Record<string, unknown>` (`node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts`, the `registerTool` overloads).

`McpUiToolMeta` (`dist/src/spec.types.d.ts:625`):

```ts
{
  resourceUri?: string;                  // e.g. "ui://plausible/timeseries.html"
  visibility?: ("model" | "app")[];      // default ["model", "app"]
  csp?: never;                           // belongs on the RESOURCE, hosts ignore it here
  permissions?: never;                   // same
}
```

Two facts that are easy to get wrong:

- `csp` and `permissions` are typed `never` on the tool. They live on the **resource**. Hosts read them from the `resources/read` content item, falling back to the `resources/list` entry. The generated JSON Schema hard-codes it: `McpUiToolMeta` carries `"csp": {"not": {}}` and `"permissions": {"not": {}}` (`dist/src/generated/schema.json`).
- There is a deprecated flat key `_meta["ui/resourceUri"]`. `registerAppTool` writes both forms for older hosts (`dist/src/server/index.d.ts`). A hand-rolled registration should write both.

`visibility` is the useful lever for a chart app: `["model"]` keeps a tool the agent calls but the iframe cannot; `["app"]` hides a tool from the model so only the iframe can call it (e.g. a "change granularity" refetch that should not enter the transcript). Enforcement is normative: hosts MUST NOT list `["app"]`-only tools to the model, MUST reject a `tools/call` from an app for a tool lacking `"app"`, and MUST always block cross-server app tool calls.

### The `ui://` resource

Registered as an ordinary MCP resource. `@modelcontextprotocol/server@2.0.0` exposes `registerResource(name, uri, config, readCallback)` (same declarations file) and `ResourceMetadata` carries `_meta`.

- URI scheme `ui://`, e.g. `ui://plausible/timeseries.html`.
- MIME type **`text/html;profile=mcp-app`** — the constant `RESOURCE_MIME_TYPE` (`dist/src/server/index.d.ts`). `registerAppResource` defaults it; hand-rolled code must set it explicitly on the content item.
- Content MUST be provided as either `text` (HTML string) or `blob` (base64 HTML), and MUST be a valid HTML5 document. Never an HTTP URL — the host does not fetch our origin for the markup.
- Servers MAY omit UI-only resources from `resources/list`.
- **No byte cap is specified.** Neither spec version states a size limit on the UI HTML; the only number anywhere is the draft's *recommendation* of 10 MB for app **tool results**, which is a different thing. Treat the practical limit as "one MCP response" and target a self-contained bundle of tens of KB, not a framework build.

`McpUiResourceMeta` (`dist/src/spec.types.d.ts:554`):

```ts
{
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  domain?: string;          // dedicated sandbox origin, host-specific format
  prefersBorder?: boolean;  // explicit value recommended; host defaults vary
}
```

`_meta.ui` may appear both on the `resources/list` entry (a static default hosts can review at connection time) and on the `resources/read` content item. **The content-item value wins**, and hosts MUST check both locations (`dist/src/server/index.d.ts`, `McpUiAppResourceConfig`; spec draft, "Metadata Location").

### `_meta.ui.csp`

`McpUiResourceCsp` (`dist/src/spec.types.d.ts:467`) is four string arrays, all **deny by default**:

| Field | CSP directives | Omitted means |
| --- | --- | --- |
| `connectDomains` | `connect-src` | no fetch/XHR/WebSocket at all |
| `resourceDomains` | `img-src`, `script-src`, `style-src`, `font-src`, `media-src` | no external scripts, styles, fonts, images |
| `frameDomains` | `frame-src` | `frame-src 'none'` |
| `baseUriDomains` | `base-uri` | `base-uri 'self'` |

When `ui.csp` is omitted entirely, the host MUST apply this policy verbatim (2026-01-26 text; the draft adds `object-src 'none';`):

```
default-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
media-src 'self' data:;
connect-src 'none';
```

When `csp` is present the host composes `connect-src 'self' <connectDomains>`, `script-src 'self' 'unsafe-inline' <resourceDomains>`, and so on. A host MAY restrict further but MUST NOT allow an undeclared domain.

`resourceDomains` supports wildcard subdomains (`https://*.example.com`). CORS still applies on top of CSP, because requests originate from the sandbox origin rather than ours. The spec types carry an explicit warning: *"MCP App HTML runs in a sandboxed iframe with no same-origin server. **All** origins must be declared — including where your bundled JS/CSS is served from."*

`domain` gives the view a stable origin so an external API can allowlist it for CORS. Formats are host-specific: Claude derives a hash subdomain of `claudemcpcontent.com`, ChatGPT a URL-derived subdomain of `oaiusercontent.com` (`dist/src/spec.types.d.ts:560`, and the `computeAppDomainForClaude` example in `dist/src/server/index.d.ts`).

### `_meta.ui.permissions`

`McpUiResourcePermissions` (`dist/src/spec.types.d.ts`, just above `McpUiResourceMeta`) is exactly four optional empty objects: `camera`, `microphone`, `geolocation`, `clipboardWrite`. They map to Permissions Policy features via the iframe `allow` attribute (`buildAllowAttribute()` in `/app-bridge` composes it). The types state hosts *MAY* honour them and apps *SHOULD NOT* assume they were granted — feature-detect. A chart needs none of them; possibly `clipboardWrite` if we ever add "copy numbers".

### The `ui/` postMessage dialect

JSON-RPC 2.0 over `postMessage`. The view acts as an MCP client, the host as an MCP server that may proxy to the real server. No SDK is required — the spec shows a raw `window.parent.postMessage` implementation. Complete method list from `dist/src/spec.types.d.ts` (the exported method constants near line 669):

**View → Host (requests)**: `ui/initialize`, `ui/open-link`, `ui/message` (`{role:"user", content:{type:"text",text}}`), `ui/update-model-context` (each call overwrites the previous), `ui/request-display-mode` (the host MUST return the resulting mode), and — draft only — `ui/download-file`. Plain MCP methods are also available from the view: `tools/call`, `resources/read`, `notifications/message`, `ping`.

**View → Host (notifications)**: `ui/notifications/initialized`, `ui/notifications/size-changed` (`{ width?, height? }` in px).

**Host → View**: notifications `ui/notifications/tool-input` (complete args, at most once, required before tool-result), `ui/notifications/tool-input-partial` (streaming, best-effort closed JSON), `ui/notifications/tool-result` (params are a standard `CallToolResult`), `ui/notifications/tool-cancelled`, `ui/notifications/host-context-changed` (a partial context — this is how a theme toggle or a container resize arrives), plus the request `ui/resource-teardown`, whose response the host SHOULD await before tearing the view down.

**Sandbox proxy** (web hosts): `ui/notifications/sandbox-proxy-ready` (proxy → host) and `ui/notifications/sandbox-resource-ready` (host → proxy, `{ html, sandbox?, csp?, permissions? }`). The proxy forwards everything not prefixed `ui/notifications/sandbox-`.

Ordering rule: the host MUST NOT send any request or notification to the view before receiving `ui/notifications/initialized`.

`ui/initialize` params (`dist/src/spec.types.d.ts:419`): `{ appInfo, appCapabilities, protocolVersion }`. The host's result carries `protocolVersion`, `hostInfo`, `hostCapabilities` and `hostContext`. `hostCapabilities.sandbox` echoes back the `permissions` and `csp` domains the host **actually approved** — approval is negotiated, not assumed. It also reports `openLinks`, `serverTools`, `serverResources`, `logging`, `updateModelContext`, `message` and `sampling`.

`McpUiHostContext` (`dist/src/spec.types.d.ts:221`), reachable in the view via `app.getHostContext()`:

- `toolInfo` — the JSON-RPC id and full `Tool` definition of the call that instantiated the app
- `theme` (`"light" | "dark"`), `styles` — see theming below
- `displayMode` and `availableDisplayModes`: `"inline" | "fullscreen" | "pip"`
- `containerDimensions` — `height`/`maxHeight` and `width`/`maxWidth`
- `locale` (BCP 47), `timeZone` (IANA), `userAgent`, `platform` (`"web" | "desktop" | "mobile"`), `deviceCapabilities.touch`/`.hover`, `safeAreaInsets`

**Proxied `tools/call`**: the view speaks the ordinary MCP client surface over the same transport, and the host "MAY forward any message from the View … for any method that doesn't start with `ui/`" — and MAY block it or gate it behind user approval. That is why `visibility` exists. The view never talks to `plausible-mcp.sentry.dev` directly and never holds a Plausible key.

### Capability negotiation

Extension id: **`io.modelcontextprotocol/ui`** (`EXTENSION_ID` in `dist/src/server/index.d.ts`). `McpUiClientCapabilities` is `{ mimeTypes?: string[] }`; `mimeTypes` is the only setting, it is REQUIRED, and it must include `text/html;profile=mcp-app`.

**Where it is advertised depends on the core protocol version, and that matters here.** Under SEP-1865 / 2026-01-26 — what ext-apps 1.7.5 and SDK 1.x implement — the client declares it once in `initialize`:

```json
"capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } }
```

Under **core 2026-07-28** it moved: clients advertise in `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` on **every request**, and servers advertise `capabilities.extensions` in the **`server/discover`** response. This Worker already serves `server/discover` (`cacheHints` in `src/server.ts`), so it is on the newer core path.

The package's own detection example is therefore doubly wrong for us:

```ts
server.server.oninitialized = () => {
  const uiCap = getUiCapability(server.server.getClientCapabilities());
  if (uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE)) { /* app tool */ }
  else { /* text-only tool */ }
};
```

It reads `initialize`-time capabilities, and it mutates the tool registry per connection — but this Worker builds a fresh `McpServer` per request (`src/worker.ts` → `createServer`) with `tools/list` cached for an hour. We should register the tool with `_meta.ui` unconditionally: a host that does not understand the extension ignores unknown `_meta` and renders `content[0].text` plus `structuredContent` exactly as today. Graceful degradation is the whole point, and it costs us nothing.

## 2. Cloudflare Workers and the SDK 2.0 question

**The `ext-apps` server helpers do not compose with `@modelcontextprotocol/server` 2.0.0.**

`@modelcontextprotocol/ext-apps@1.7.5` declares `@modelcontextprotocol/sdk: ^1.29.0` as a **peer dependency**, and `dist/src/server/index.js` has runtime imports from `@modelcontextprotocol/sdk/shared/protocol.js` and `@modelcontextprotocol/sdk/types.js`. Its types import `McpServer`, `ResourceMetadata`, and `ToolCallback` from `@modelcontextprotocol/sdk/server/mcp.js` — the **legacy v1 SDK**, a different package from the `@modelcontextprotocol/server@2.0.0` this repo uses. `registerAppTool` takes `Pick<McpServer, "registerTool">` typed against v1; our 2.0 `McpServer` has a different `registerTool` signature (Standard Schema, new `ToolCallback`). Nothing in `dist` imports `@modelcontextprotocol/core` or `@modelcontextprotocol/server`.

Workers compatibility is not the blocker, for the record:

- `dependencies` is a single package, `@standard-schema/spec`. Everything else is a peer or dev dependency.
- `grep -ro 'node:[a-z_]*' dist/` over the whole package returns **nothing** — no Node built-ins, no `require(`, no `process.`, no `Buffer.`.
- `wrangler.toml` already sets `nodejs_compat_v2`.

So the package would *run* on a Worker. It just brings the wrong SDK. (The v1 SDK's own Workers compatibility is a separate question we do not need to answer.)

**Recommendation**: skip `@modelcontextprotocol/ext-apps/server` entirely. What the helpers do is normalize `_meta.ui.resourceUri` into the deprecated `_meta["ui/resourceUri"]` alias and default the MIME type — roughly fifteen lines we can write ourselves against 2.0.0's `registerTool`/`registerResource`, both of which already accept `_meta` and arbitrary URI schemes.

The v2 migration is tracked upstream and still open: issue [modelcontextprotocol/ext-apps#702](https://github.com/modelcontextprotocol/ext-apps/issues/702), PRs [#719](https://github.com/modelcontextprotocol/ext-apps/pull/719) and [#720](https://github.com/modelcontextprotocol/ext-apps/pull/720). Watch it and adopt the helpers when one lands.

One more Workers detail: the official build guide loads the bundled HTML with `fs.readFile`/`path.join` (<https://modelcontextprotocol.io/extensions/apps/build>). On a Worker, inline the string at build time or use an asset binding.

`@modelcontextprotocol/ext-apps` (the default export, `/react`, `/app-bridge`) is still the right dependency for the **iframe bundle**: `App` (with `connect`, `callServerTool`, `readServerResource`, `sendSizeChanged`, `requestDisplayMode`, `openLink`, `downloadFile`, `updateModelContext`, `getHostContext`), `PostMessageTransport`, `applyHostStyleVariables`, `applyHostFonts`, and the React hooks `useApp`, `useAutoResize`, `useDocumentTheme`, `useHostStyles`. That code runs in the browser and is inlined into the `ui://` resource at build time, so it never touches the Worker runtime and does not belong in the Worker's dependency graph.

## 3. Rendering constraints that bind the design

1. **Sandboxed iframe, no same-origin server.** Sandboxing is normative: all view content MUST render in sandboxed iframes. Web hosts MUST use a double-iframe pattern with the host and the sandbox on **different origins**, the outer proxy carrying `allow-scripts allow-same-origin`. The token list applied to the *inner* iframe holding our HTML is **not specified** — the host may override it via the `sandbox` string in `ui/notifications/sandbox-resource-ready`. Assume little. The HTML arrives inline over MCP with no origin serving sibling assets, so everything — JS, CSS, fonts, any chart library — must be inlined into one HTML string or declared in `resourceDomains`. A build step producing a single self-contained file (the official guide recommends `vite-plugin-singlefile`) is the only sane shape.
2. **Deny-by-default CSP.** With no `_meta.ui.csp`, the view has zero network access. It renders the data the host pushes via `ui/notifications/tool-result` and nothing else. That is exactly what a chart wants, and it is the strongest posture: **ship with no `csp` block at all**. Any `connectDomains` entry is a security decision that needs justifying.
3. **Downloads are blocked.** Sandboxed iframes cannot start a download — the draft spec states `allow-downloads` is not set — so downloads route through `ui/download-file`. A "download CSV" button must call that method, not use `<a download>`.
4. **Theming is host-driven and generous.** `hostContext.theme` gives `"light" | "dark"`, and `hostContext.styles.variables` supplies a fixed enum of roughly seventy CSS custom properties the host fills in — `--color-background-primary`, `--color-text-secondary`, `--color-border-*`, `--color-ring-*`, semantic `info`/`danger`/`success`/`warning` variants, `--font-sans`, `--font-mono`, a full type scale, `--border-radius-*`, `--shadow-*` (`McpUiStyleVariableKey`, `dist/src/spec.types.d.ts:31`). Hosts may supply any subset or none, so every variable needs a fallback. **The chart must be built on these tokens, not on a hardcoded Sentry palette** — that is what makes it look native in Claude and in ChatGPT. Series colors are the one thing with no token; pick an accessible set and validate it in both themes. Fonts arrive separately as raw CSS (`@font-face`/`@import`) in `hostContext.styles.css.fonts`. Theme changes arrive later via `ui/notifications/host-context-changed`, so the view must re-render on it rather than reading the theme once at startup.
5. **Sizing is a negotiation.** `containerDimensions` is per-axis: fixed (`height`/`width` — the view fills it), flexible (`maxHeight`/`maxWidth` — the view sizes itself up to the cap), or unbounded (omitted). Under flexible dimensions the host MUST honour `ui/notifications/size-changed`, which the view emits with pixel width/height from a ResizeObserver (`useAutoResize` does this automatically, debounced). **There is no protocol-level maximum height** — the cap is whatever the host puts in `maxHeight`. Design for an unknown width and a possibly-capped height. `displayMode` is `inline | fullscreen | pip`, requested with `ui/request-display-mode` and granted or refused by the host — do not assume fullscreen.
6. **Border and background.** Set `prefersBorder` explicitly; host defaults differ.
7. **`domain`** is only needed if the view must call an external API under CORS. Ours will not.

### Per-host differences

- **Claude (web and Desktop)** — <https://claude.com/docs/connectors/building/mcp-apps/getting-started>. Requests from a Claude MCP app carry `Origin: {hash}.claudemcpcontent.com`, where the hash is the first 32 hex characters of the SHA-256 of the **exact full server URL** (a trailing slash changes it). An external API we called would need `*.claudemcpcontent.com` in its CORS allowlist; `_meta.ui.domain` opts into a *stable* such origin. We call nothing external, so this does not apply — but it is why `domain` exists.
- **ChatGPT** — <https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt/>. Implements the standard; reads `_meta.ui.resourceUri`, `domain`, `csp`, `prefersBorder`; **nested frames blocked by default**; also honours the legacy `_meta["openai/outputTemplate"]` alias. Its `window.openai.*` API is ChatGPT-specific — do not build on it.
- **Microsoft 365 Copilot** — sandbox origin `{sha256}.widget-renderer.usercontent.microsoft.com`; supports `connectDomains` and `resourceDomains` but **not** `frameDomains`, `baseUriDomains`, or `permissions`; inline and fullscreen only, no PiP.
- **VS Code Copilot** — announced 2026-01-26 (<https://code.visualstudio.com/blogs/2026/01/26/mcp-apps-support>), Insiders first. Sandbox and theming specifics not documented.

Assume the intersection and feature-detect. Everything we need — inline HTML, no network, host tokens, auto-resize — is inside it.

**Rendering hosts**, per the official client matrix (<https://modelcontextprotocol.io/extensions/client-matrix>): Claude (web), Claude Desktop, ChatGPT, VS Code GitHub Copilot, Microsoft 365 Copilot, Cursor, Goose, Postman, MCPJam, Archestra.AI, PostHog Code, plus the mcp-use Inspector. **Claude Code is not on it**, and structurally cannot be — a TUI has no iframe. Every primary mention of Claude Code in the MCP Apps docs concerns *authoring* apps there via the skills plugin, never rendering.

## 4. Which tool leads: `get_timeseries`

Judged on output shape (`src/schemas.ts`, `src/tools/`):

| Tool | `structuredContent` | Visual it wants |
| --- | --- | --- |
| `get_timeseries` | `queryResultOutputSchema`, one row per `time:day\|week\|month` bucket, ordered and dense | **line/area chart** |
| `get_breakdown` | same schema, one row per dimension value, up to `limit` 1000 | ranked bar list or table |
| `get_conversions` | same schema, rows keyed by `event:goal` (optionally × `event:page`) | small table |
| `compare_periods` | bespoke `comparePeriodsOutputSchema` — two aggregate maps plus per-metric `{ absolute, percent }` | two stat tiles and a delta |

`get_timeseries` leads, for four reasons:

1. **It is the only tool whose output is inherently a series.** An ordered, dense, single-dimension result is exactly a line chart. Everything else is a table wearing a chart costume.
2. **Its renderer generalizes to three of the four tools.** `get_timeseries`, `get_breakdown`, and `get_conversions` all emit `queryResultOutputSchema` — `{ metrics[], dimensions[], results: [{ dimensions[], metrics[] }] }` (`src/schemas.ts:285`). One component that reads that envelope and switches marks on whether `dimensions[0]` starts with `time:` covers the rollout. `compare_periods` is the odd one out with its own schema, so leading with it would build a renderer that generalizes to nothing.
3. **The map wants this same artifact as the landing page's live demo (#42).** A traffic line chart reads as "analytics" in under a second to a visitor who has never used the server. A pair of delta tiles does not.
4. **Its inputs are the demo-friendly ones.** `date_range` and `granularity` are two controls a visitor can move, and both map to a re-call of the same tool. `compare_periods` needs two date ranges chosen coherently before anything interesting appears.

The tempting counter-argument — that `compare_periods` is the tool whose text output is hardest to read, so it gains most from a UI — is real but secondary. It is the second tool to get an app, not the first.

## 5. Is Claude Code not rendering MCP Apps a real cost?

No, for two reasons.

**The endpoint that matters already targets rendering hosts.** The Worker has two (`src/worker.ts`, README "Self-Hosting"):

- `/mcp` — bring-your-own-key, for header-capable clients. The README names Claude Code, Cursor, MCP Inspector.
- `/internal` — Cloudflare Access Managed OAuth, for managed connectors. The README names Cowork and Claude.ai; `MCP_ALLOWED_ORIGIN_HOSTNAMES` in `wrangler.toml` is literally `claude.ai,localhost,127.0.0.1`.

`/internal` — the Sentry-employee path, the one with a shared key and the traffic we actually care about — is used from exactly the hosts that render MCP Apps.

**Degradation is free and total.** A tool with `_meta.ui` still returns `content[0].text` and `structuredContent` unchanged. Claude Code ignores an unknown `_meta` key and behaves exactly as it does today. There is no fallback to write, no branch to maintain, and no regression to test for. The only cost is the bytes of one extra `resources/list` entry.

## 6. What the prototype must respect

- Register on `@modelcontextprotocol/server@2.0.0` directly. Do **not** add `@modelcontextprotocol/ext-apps` to the Worker's `dependencies`.
- Tool `_meta`: `{ ui: { resourceUri: "ui://plausible/timeseries.html" }, "ui/resourceUri": "ui://plausible/timeseries.html" }`.
- Resource: `ui://plausible/timeseries.html`, MIME `text/html;profile=mcp-app`, inline `text`, `_meta.ui = { prefersBorder: <decide>, csp: omitted }`.
- One self-contained HTML file. No CDN, no external font, no runtime fetch.
- Theme from `hostContext.styles.variables` with a fallback for every key; correct in light and dark; re-render on `ui/notifications/host-context-changed`.
- Auto-resize via `ui/notifications/size-changed`; no assumed width, capped height, no assumed `fullscreen`.
- Register unconditionally. Do not branch on `getUiCapability` — this server is stateless per request, caches `tools/list` for an hour, and is on the `server/discover` core path where that `initialize`-time helper does not apply anyway.
- The `ui://` resource read path must stay cheap. It is a static string; give it a `cacheHint` alongside the existing `server/discover` and `tools/list` hints in `src/server.ts`.
- Both entry points get the tool (`src/index.ts` STDIO and `src/worker.ts`), and both `pnpm build` and `pnpm typecheck` must pass — see `CLAUDE.md`.

## Open item for the map, not for this ticket

Serving the landing page at `/` from this Worker collides with the Cloudflare Access setup. The Managed OAuth application must cover the **bare hostname with no path** (Cloudflare rejects a path once OAuth is on), and `/mcp` is only public because a second, more-specific `Bypass` application carves it out. A public `/` needs the same treatment, and "more specific than the bare host" is not obviously expressible for the root path. `src/worker.ts` also stamps `X-Frame-Options: DENY` on every response, which is right for the MCP endpoints and would need scoping if the page ever embeds anything. Worth resolving before the "how the page ships" ticket.
