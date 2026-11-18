# Motvin MCP server

Lets AI clients (Claude, Cursor, ChatGPT, Codex, VS Code, …) search the
Inspirations library on behalf of a signed-in Motvin user, over the Model
Context Protocol.

- Endpoint: `https://api.motvin.com/api/mcp` (Streamable HTTP, JSON responses)
- Sign-in: OAuth 2.1 with PKCE and dynamic client registration. No API keys.
  The client opens `https://motvin.com/mcp/connect`, where the person signs in
  with their Motvin account and approves the client.
- Code: `src/modules/mcp/`
- Web: `motvin.com/mcp` explains it and gives per-tool setup
  (`motvin-web/src/app/mcp`); `motvin.com/mcp/connect` is the sign-in and
  approval step (`motvin-web/src/app/mcp/connect`).

## Connecting a client

Any client that supports Streamable HTTP + OAuth: add an HTTP MCP server with
the endpoint URL above. On first use a browser window opens on the connect
page. Claude Code, for example:

```bash
claude mcp add --transport http motvin https://api.motvin.com/api/mcp
```

then `/mcp` → Motvin → Authenticate.

## Tools

All read-only. Every search names one platform (`ios`, `webapp`, `web`) and
every result list holds one platform — iOS, Web Apps and Webs never mix. To
compare platforms, call once per platform.

| Tool | What it does |
| --- | --- |
| `search_screens` | Plain-language search for screens, with filters (screen_type, state, industry, style, element, app). Returns ranked screens, each with a small preview image, plus the screen types among the matches. |
| `search_flows` | Multi-step journeys (onboarding, checkout, …), with previews of the opening steps. |
| `search_screen_text` | Screens by the words printed on them (OCR), e.g. "cancel anytime". |
| `get_screen` | One screen in full: larger preview, description, elements, text on screen, the flows and patterns it is in. |
| `find_similar_screens` | Screens like a given one, on the same platform, by recorded metadata. |
| `get_flow` | Every step of one flow, in order, with the action between steps. |
| `list_apps` / `get_app` | The apps in the library; one app on one platform with its flows and screen types. |
| `list_patterns` / `get_pattern` | Curated patterns and the screens that show one, on one platform. |
| `get_taxonomy` | The exact filter values a platform accepts, and its counts. |

### Result order

The library search scores coarsely, so a broad query gives many screens the
same score. Left to the search's own tie-break (screen id, which starts with
the app name) every broad query opened on the same A–C apps. The MCP server
orders results itself (`src/modules/mcp/mcp-ranking.ts`), keeping the search
score as the first key:

1. among equal scores, screens showing more real UI first — prices, buttons,
   tables beat a video intro or a loading frame;
2. still tied, apps in an order that depends on the query, not the alphabet
   (stable: the same question gives the same page);
3. one screen per app per round (near-copies last), alternating kinds of app
   (industries) among equal scores.

So five results are five apps. Nothing is dropped; paging reaches every match.
Searching inside one app (`app=…`) keeps all of that app's screens in order.
The website's own search is unchanged.

### Images

Each screen in a result carries:

- an inline preview (JPEG, ~360px wide for phone captures, wider for landscape
  ones) so the model can look at it;
- `image_url`, the full-resolution file — **only when the screen's licence
  allows download**, matching the 403 the image route returns otherwise;
- `page_url`, the screen on motvin.com.

Previews are produced by `ScreenPreviewService` with sharp and cached in memory.

## How sign-in works

`McpOAuthService` is a complete authorization server with no database:

1. **Discovery.** A client that gets a 401 from `/api/mcp` reads
   `/.well-known/oauth-protected-resource/api/mcp`, then
   `/.well-known/oauth-authorization-server`, to find the endpoints under
   `/api/mcp/oauth/`.
2. **Registration** (`POST register`). The client's `client_id` is a signed
   copy of what it registered (name, redirect URIs), so nothing is stored.
   Clients that support Client ID Metadata Documents (CIMD) skip this: their
   `client_id` is an https URL serving a JSON document with their name and
   redirect URIs, which the server fetches at authorization (https only,
   private addresses refused, no redirects, 5 s timeout, 64 KB cap) and keeps
   for 5 minutes. The metadata advertises `client_id_metadata_document_supported`.
3. **Authorization** (`GET authorize`). The request is checked and the person
   is redirected to the connect page with a signed `request` token (10 min).
4. **Approval** (`GET request`, `POST approve`). The connect page shows who is
   asking, signs the person in with Firebase, and posts their ID token. It is
   verified against Google's public keys (shared with the admin guard); guest
   sessions are refused. The client gets a signed, single-use authorization
   code (5 min).
5. **Tokens** (`POST token`). PKCE S256 is checked; the client receives an
   access token (1 h) and a refresh token (30 days, rotated on use).
   Both carry the same connection id (`grant`), kept across refreshes.
6. **Disconnect** (`POST revoke`, RFC 7009). Revoking either token blocks the
   whole connection: its access token is refused on the very next request
   (not after its hour runs out) and its refresh token can no longer be used.

Codes being single-use is an in-memory map (they live 5 minutes). Revocations
— disconnected connections and rotated refresh tokens — go in a small JSON
file (`MCP_REVOCATION_FILE`), each entry kept only until the tokens it blocks
would have expired, so a restart never brings a disconnected tool back.
Everything else is stateless. With several API instances the file has to be
on shared storage for a disconnect to reach all of them.

## Connected tools, usage and search

- **Connected tools.** Every connection (its `grant`) is listed in a small file
  (`MCP_CONNECTIONS_FILE`, default `<DATA_ROOT>/.mcp-connections.json`) with the
  tool's name and when it was connected and last used. Motvin's settings page
  (Settings → AI tools) reads it through `GET /api/mcp/connections` and
  disconnects with `DELETE /api/mcp/connections/:id`, both with the person's
  Firebase ID token. A disconnect from settings works like a revoke: the tool's
  keys stop working on the next request.
- **Usage.** `McpUsageService` counts, per day: tool calls by tool and by AI
  tool, errors, rate-limited calls, new connections, active people (as one-way
  hashes, never ids or emails) and the most common searches. Kept 90 days in
  `MCP_USAGE_FILE` (default `<DATA_ROOT>/.mcp-usage.json`). The admin sees it
  in the library admin's **MCP usage** tab via `GET /api/mcp/usage?days=30`,
  behind the same AdminGuard as the library admin API.
- **Meaning-based search.** `search_screens` adds a relevance score from
  `SemanticIndex` (inspirations/semantic-search.ts): word forms share a stem,
  ~50 groups of same-meaning UI words share a concept (basket ≈ cart,
  unsubscribe ≈ cancel, create account ≈ sign up), and fields are weighted with
  BM25. Words that hint at a type ("account" → settings) add points instead of
  filtering, so "create an account" finds sign-up screens; the tools' explicit
  filters stay strict. The website's own search is unchanged.

## Rate limits

So one person, script or runaway AI loop cannot flood the server or copy the
library, `McpRateLimitService` keeps three budgets:

| Budget | Default | When it runs out |
| --- | --- | --- |
| Tool calls per signed-in person | 60 a minute, 2000 a day | The call returns a tool error saying when to try again, which the AI can relay |
| Screen previews per person | 60 a minute | Results come back without images, with a note saying when previews return |
| OAuth requests per client address | 30 a minute | `429 Too Many Requests` with `Retry-After` |

The address is `CF-Connecting-IP` when present (set by Cloudflare, not
forgeable by the client), else Fastify's `request.ip`. Counters are in memory,
so with several API instances each keeps its own; one shared budget would need
a shared store such as Redis. Each limit is a setting below; 0 turns it off.

## Configuration

| Variable | Meaning |
| --- | --- |
| `MCP_TOKEN_SECRET` | Signs every token. **Required in production** — without it MCP answers 503 while the rest of the API runs. In development a throwaway secret is generated per boot. |
| `MCP_ISSUER_URL` | Public origin of this API (default `https://api.motvin.com` in production, `http://localhost:3000` otherwise). Also used to build absolute image URLs. |
| `MCP_CONNECT_URL` | The connect page (default `https://motvin.com/mcp/connect` in production, `http://localhost:3001/mcp/connect` otherwise). |
| `MCP_SITE_URL` | Public site, for `page_url` links (default `https://motvin.com` in production, `http://localhost:3001` otherwise). |
| `MCP_CONNECTIONS_FILE`, `MCP_USAGE_FILE` | Where connected tools and usage counts are kept (defaults under `DATA_ROOT`). |
| `MCP_RATE_LIMIT_FILE` | Each person's call count for the day, saved so a restart doesn't reset it (default `<DATA_ROOT>/.mcp-rate-limits.json`). |
| `MCP_RATE_CALLS_PER_MINUTE`, `MCP_RATE_CALLS_PER_DAY` | Tool calls allowed per person (defaults 60 and 2000; 0 = no limit). |
| `MCP_RATE_PREVIEWS_PER_MINUTE` | Screen previews per person per minute (default 60). |
| `MCP_RATE_OAUTH_PER_MINUTE` | Requests per client address per minute to the OAuth endpoints (default 30). |
| `MCP_REVOCATION_FILE` | Where disconnects are remembered across restarts (default `<DATA_ROOT>/.mcp-revocations.json`). Put it on a disk that survives deploys. |

Firebase verification uses the existing `FIREBASE_PROJECT_ID`.

## Logging

Every tool call is logged as `<email> <tool> <arguments> <ms>`; every approval
as `<email> approved <client>`. There is no per-user rate limit yet.

## Tests

`src/modules/mcp/mcp.http.spec.ts` drives the server over HTTP: discovery,
the 401 challenge, the whole OAuth flow (including PKCE failures, code reuse,
refresh rotation, guest refusal) and tool calls that honour the platform rule.
