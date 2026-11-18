# Motvin plugin for the ChatGPT directory

The package OpenAI's plugin portal (platform.openai.com/plugins) takes to list
Motvin in ChatGPT's directory, so people can add it with one click.

- `plugin.json` — listing (name, descriptions, prompts, links, icons) and the
  review test cases (5 that should use Motvin, 3 that should not).
- `mcp.json` — the live MCP server and its sign-in (OAuth with a Client ID
  Metadata Document, which ChatGPT uses).
- `assets/` — the Motvin logo, light and dark, 512 × 512.

Before uploading:

1. Record a short demo video of Motvin working in ChatGPT, upload it somewhere
   a reviewer can open (an unlisted YouTube or Loom link), and put the link in
   `demo_recording_url` in plugin.json.
2. Build the ZIP from this folder:

   ```bash
   cd chatgpt-plugin && rm -f motvin.zip && zip -r motvin.zip plugin.json mcp.json assets
   ```

3. Upload `motvin.zip`. In the portal's **Review details**, add a Motvin test
   account (email and password, no codes) for the reviewers.

Field limits are checked by the portal; see OpenAI's "Submit plugins" guide.
