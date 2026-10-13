# @demarker/mcp

MCP server for [Demarker](https://demarker.io): identify what an AI image carries, then clean it.

**Install**

- Claude Code: `claude mcp add demarker -- npx -y @demarker/mcp`
- Cursor, VS Code: one-click buttons at https://demarker.io/developers
- Claude Desktop, Windsurf, Cline:

```json
{ "mcpServers": { "demarker": { "command": "npx", "args": ["-y", "@demarker/mcp"],
  "env": { "DEMARKER_API_KEY": "sk_live_YOUR_KEY" } } } }
```

**Tools**: `demarker_identify` (free; works without a key), `demarker_clean` (spends credits), `demarker_get_balance`, `demarker_get_pricing`, `demarker_get_job`.

**Safety**

- `demarker_clean` needs `maxCredits`, and a hard per-call ceiling applies whatever the model asks for (default 2, set `DEMARKER_MCP_MAX_CREDITS`).
- The user must confirm the rights statement. Clients that support elicitation show it to the user; others must pass `rightsAttested: true` only after the user explicitly agreed.
- Results are written next to the input and never overwrite a file.

Env: `DEMARKER_API_KEY` (to clean; create at https://demarker.io/app/settings/api), `DEMARKER_API_URL`, `DEMARKER_MCP_MAX_CREDITS`.
