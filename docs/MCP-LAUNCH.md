# Launching Motvin MCP

Everything needed to take Motvin MCP from localhost to `api.motvin.com`, test
it with real tools, and list it in the stores. Work top to bottom; nothing here
has been run against production yet.

## 1. Commit

Commit the MCP work in both repositories (motvin-backend and motvin-web).
Check `data/inspirations/manifest.json` before committing — it was changed
outside the MCP work.

## 2. Backend → api.motvin.com

The live server today runs an older backend: `/health` and
`/api/inspirations/*` answer, `/api/mcp` and `/.well-known/oauth-*` are 404.

On the server, in the backend folder:

1. **Secret.** Create `.env` next to `docker-compose.yml` (never commit it) with
   a new secret, made on the server — not the one from your laptop:

   ```bash
   echo "MCP_TOKEN_SECRET=$(openssl rand -hex 32)" >> .env
   chmod 600 .env
   ```

   Keep this value forever: changing it signs everyone out of their AI tools.
2. **State folder.** `docker-compose.yml` mounts `./data` read-only, so MCP
   writes its files to `./mcp-state` instead (connected tools, disconnects,
   usage, today's call counts). Create it once; never delete it on deploy:

   ```bash
   mkdir -p mcp-state
   ```

3. **Deploy.** `git pull`, then `docker compose up -d --build`.
4. **Check** (all should answer 200, the last one 401):

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://api.motvin.com/health
   curl -s -o /dev/null -w "%{http_code}\n" https://api.motvin.com/.well-known/oauth-protected-resource/api/mcp
   curl -s -o /dev/null -w "%{http_code}\n" https://api.motvin.com/.well-known/oauth-authorization-server
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.motvin.com/api/mcp
   ```

   If the server sits behind Cloudflare or another proxy, make sure
   `/.well-known/*` reaches the backend at the origin root.

Defaults that already point at production when `NODE_ENV=production`:
`MCP_ISSUER_URL=https://api.motvin.com`, `MCP_CONNECT_URL=https://motvin.com/mcp/connect`,
`MCP_SITE_URL=https://motvin.com`. Rate limits default to 60 calls a minute and
2000 a day per person.

## 3. Website → motvin.com

Build with `NEXT_PUBLIC_API_BASE_URL=https://api.motvin.com` (and the usual
`NEXT_PUBLIC_FIREBASE_*` values) and deploy as usual. New pages: `/mcp`,
`/mcp/clients`, `/mcp/clients/<tool>`, `/mcp/connect`, Settings → AI tools,
the admin's MCP usage tab, and the updated `/privacy` (it now covers AI-tool
connections).

## 4. Test live

With `https://api.motvin.com/api/mcp`:

- [ ] Claude Code: add, sign in, search, then disconnect in Settings → AI tools and confirm the next search is refused.
- [ ] Cursor and VS Code: the "Add to" buttons.
- [ ] ChatGPT: Plugins → Add → Add custom MCP server (needs the live https address).
- [ ] Claude (web): the "Add to Claude" button (prefilled custom connector).
- [ ] Replit and Figma: add the address; both require public https.
- [ ] Settings → AI tools lists each tool; usage card counts calls; restart the backend and check "Today" keeps its number.

## 5. Stores (all free)

### MCP Registry (VS Code, GitHub Copilot and others read it)

`server.json` in this folder is ready. Publishing:

1. Install the publisher: `brew install mcp-publisher`.
2. Prove you own motvin.com — the name `com.motvin/motvin` needs it. Run
   `mcp-publisher login dns --domain motvin.com --private-key <key>` and add the
   TXT record it prints to motvin.com's DNS.
3. `mcp-publisher publish` from this folder.

Check the current schema URL and commands on registry.modelcontextprotocol.io
first — they have changed between versions.

### Claude connectors directory (Anthropic)

Apply through Anthropic's connector directory form. Ready answers:

- **Name:** Motvin
- **Server URL:** `https://api.motvin.com/api/mcp`
- **Authentication:** OAuth 2.1 with PKCE; dynamic client registration and Client ID Metadata Documents both supported.
- **Short description:** Real app screens and flows from shipped apps, for AI design work.
- **Long description:** Motvin is a library of real product UI — screens and step-by-step flows captured from shipped iOS apps, web apps and marketing websites. Connected, Claude can search it in plain words ("paywalls with an annual toggle", "fintech onboarding"), look at each screen, walk through whole flows, and compare how real apps solve a problem before it designs or reviews yours.
- **Tools (all read-only):** search_screens, search_flows, search_screen_text, get_screen, find_similar_screens, get_flow, list_apps, get_app, list_patterns, get_pattern, get_taxonomy.
- **Example prompts:** "Search Motvin for onboarding screens from fintech apps on iOS" · "Show me 5 paywalls and tell me what they have in common" · "How do food apps handle checkout? Walk me through a real flow".
- **Account needed:** a free Motvin account (sign-in happens in the browser during connect).
- **Privacy policy:** https://motvin.com/privacy
- **Terms:** https://motvin.com/terms
- **Support contact:** motvintool@gmail.com
- **Documentation:** https://motvin.com/mcp

### ChatGPT plugins (OpenAI)

Submit through OpenAI's developer platform; OpenAI may ask to verify the
business first. Use the same name, URL, descriptions, tool list, prompts,
privacy, terms and support details as above. Authentication: OAuth.
