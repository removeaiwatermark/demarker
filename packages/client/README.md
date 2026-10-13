# @demarker/client

Typed client for the [Demarker](https://demarker.io/developers) API: identify what an AI image carries, then clean it. No runtime dependencies, Node 20+.

```ts
import { DemarkerClient } from "@demarker/client";
import { readFile } from "node:fs/promises";

const client = new DemarkerClient({ apiKey: process.env.DEMARKER_API_KEY });
const bytes = new Uint8Array(await readFile("image.png"));

// Free. Without an apiKey, use client.scanBytes() (keyless, rate-limited).
const job = await client.identifyBytes(bytes, "image.png");
console.log(job.offers);

// Spends credits. maxCredits is required; nothing is charged above it.
// rightsAttested must come from a real confirmation by the person who owns
// or may edit the image. There is no default.
const { image } = await client.clean({
  bytes, filename: "image.png", maxCredits: 1, rightsAttested: true,
});
```

Base URL defaults to `https://demarker.io/api/v1`; override with `baseUrl` or `DEMARKER_API_URL`. Errors are `DemarkerApiError` (API envelope: `code`, `status`, `details`) or `DemarkerClientError` (a rule enforced before any request, such as `OVER_CREDIT_CAP`).

Create an API key at https://demarker.io/app/settings/api. See the [OpenAPI spec](https://demarker.io/api/v1/openapi).
