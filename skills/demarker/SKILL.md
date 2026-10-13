---
name: demarker
description: Identify what an AI-generated image carries (visible marks, AI metadata, inferred hidden watermarks like SynthID) and clean it, using the Demarker CLI, MCP server or API. Use when asked to check an image for AI watermarks or provenance, remove an AI watermark or AI metadata from the user's own image, or see what a clean would cost.
---

# Demarker

Demarker (https://demarker.io) scans an image for what marks AI provenance, then cleans the user's own images. Scanning is free and needs no account. Cleaning spends credits.

## When to use

- The user wants to know whether an image carries an AI watermark, AI metadata or C2PA data.
- The user wants an AI watermark or AI metadata removed from an image they own or may edit.
- The user asks what a clean would cost.

Do not use it for stock or marketplace watermarks, or to remove a protective mark such as Glaze or Nightshade. Demarker refuses those.

## Scan (free, no key)

```bash
npx demarker identify image.png
```

Prints the vendor, whether a hidden-watermark target was inferred, and the price of a clean. Hidden watermarks cannot be decoded, so this is an inference.

## Clean (spends credits, needs an API key)

Create a key at https://demarker.io/app/settings/api and set `DEMARKER_API_KEY`.

```bash
npx demarker clean image.png --max-credits 1 --attest-rights
```

- 1 credit is one GPU clean up to 12 MP; 2 credits at original size above that.
- `--max-credits` is required. Nothing is charged if the quote is over it.
- The user must confirm the rights statement: they own the image or have the right to edit it, they will follow the generator's terms and any labelling rules, and they are 18 or older. Never pass `--attest-rights` (or `rightsAttested: true`) on your own. Show the user the statement and get an explicit yes first.
- Results are saved as `<name>.clean.<ext>` and never overwrite an existing file.
- Exit codes: 0 ok, 2 usage, 3 auth, 4 credits, 5 rejected, 6 region blocked, 7 job failed, 8 network.

## MCP

`@demarker/mcp` exposes the same flow as tools: demarker_identify, demarker_clean, demarker_get_balance, demarker_get_pricing, demarker_get_job. Install in Claude Code with:

```bash
claude mcp add demarker -- npx -y @demarker/mcp
```

## API

OpenAPI: https://demarker.io/api/v1/openapi. Keyless scan: `POST /api/v1/scan` (multipart field `file`), then `GET /api/v1/scan/{id}` with the token in `X-Claim-Token`.

## Limits

Hidden-watermark removal is best effort and cannot be verified from the file. Output may still need an AI label where it is published. Not available in sanctioned regions or mainland China.
