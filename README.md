# Demarker agent tools

Open-source client, CLI, MCP server and agent skill for [Demarker](https://demarker.io): see and remove what an AI generated image have hidden in them (visible marks, AI metadata, inferred hidden watermarks such as SynthID), then remove them!

Scanning is free and needs no account. Cleaning needs an API key and credits, and the person using it confirms a rights statement each time.

| Package | What it is |
|---|---|
| [`demarker`](packages/cli) | CLI: `npx demarker identify image.png` |
| [`@demarker/mcp`](packages/mcp) | MCP server for Claude, Cursor, VS Code and others |
| [`@demarker/client`](packages/client) | Typed API client (no runtime dependencies) |
| [`skills/demarker`](skills/demarker/SKILL.md) | Agent skill: `npx skills add AIDemarker/demarker` |

## Quick start

```bash
npx demarker identify image.png                          # free, no key
export DEMARKER_API_KEY=sk_live_...                      # https://demarker.io/app/settings/api
npx demarker clean image.png --max-credits 1 --attest-rights
```

MCP, Claude Code: `claude mcp add demarker -- npx -y @demarker/mcp`. One-click Cursor and VS Code installs: https://demarker.io/developers

## Safety by design

- Spending is capped: `--max-credits` is required, and the MCP server also enforces a per-call ceiling (default 2 credits).
- The rights attestation is never defaulted. The CLI asks, or needs an explicit `--attest-rights`; the MCP server asks the user through the client where supported.
- Results never overwrite an existing file.

## Development

```bash
pnpm install && pnpm build && pnpm test
```

This repository is published from Demarker's main codebase; issues and pull requests are welcome here. API reference: https://demarker.io/api/v1/openapi

MIT licensed.
