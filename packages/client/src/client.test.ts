import assert from "node:assert/strict";
import { test } from "node:test";
import { DemarkerClient } from "./client.ts";
import type { DemarkerApiError, DemarkerClientError } from "./errors.ts";

const BASE = "http://localhost:3300/api/v1";

function job(over: Record<string, unknown> = {}) {
	return {
		id: "job1",
		status: "IDENTIFIED",
		progress: null,
		width: 1024,
		height: 1024,
		megapixels: 1.05,
		band: "small",
		hasInvisibleTarget: true,
		vendor: "google",
		report: {},
		cmiFields: null,
		offers: [
			{ tier: "GPU", keepResolution: false, credits: 1 },
			{ tier: "GPU", keepResolution: true, credits: 2 },
		],
		balance: 5,
		attestationVersion: null,
		tier: null,
		keepResolution: null,
		creditsCharged: null,
		refusalReason: null,
		processBlocked: null,
		errorCode: null,
		errorMessage: null,
		cleanReport: null,
		outputs: { image: null },
		createdAt: "2026-10-12T00:00:00.000Z",
		completedAt: null,
		expiresAt: null,
		...over,
	};
}

type Call = {
	method: string;
	url: string;
	body?: unknown;
	headers: Record<string, string>;
};

function mock(
	routes: (
		c: Call,
	) => { status?: number; json?: unknown; bytes?: Uint8Array } | undefined,
) {
	const calls: Call[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const c: Call = {
			method: init?.method ?? "GET",
			url: String(input),
			body:
				typeof init?.body === "string"
					? JSON.parse(init.body)
					: init?.body,
			headers: (init?.headers ?? {}) as Record<string, string>,
		};
		calls.push(c);
		const r = routes(c);
		if (!r) {
			throw new Error(`unmocked ${c.method} ${c.url}`);
		}
		if (r.bytes) {
			return new Response(r.bytes as BodyInit, {
				status: r.status ?? 200,
			});
		}
		return new Response(JSON.stringify(r.json), {
			status: r.status ?? 200,
		});
	}) as typeof fetch;
	return { calls, fetchImpl };
}

function happyPath(
	extra?: (c: Call) => ReturnType<Parameters<typeof mock>[0]>,
) {
	return (c: Call) => {
		const own = extra?.(c);
		if (own) {
			return own;
		}
		if (c.url.endsWith("/upload")) {
			return {
				json: {
					uploadUrl: "https://r2.example/put",
					uploadKey: "uploads/api_x/input.png",
					expiresAt: "",
					maxFileSizeBytes: 1,
					maxFileSizeMb: 1,
					contentType: "image/png",
				},
			};
		}
		if (c.url === "https://r2.example/put") {
			return { json: {} };
		}
		if (c.url.endsWith("/identify")) {
			return { json: job() };
		}
		if (c.url.endsWith("/process")) {
			return { json: job({ status: "PENDING", creditsCharged: 1 }) };
		}
		if (c.url.endsWith("/jobs/job1")) {
			return {
				json: job({
					status: "COMPLETED",
					creditsCharged: 1,
					outputs: { image: "https://r2.example/out.png" },
				}),
			};
		}
		if (c.url === "https://r2.example/out.png") {
			return { bytes: new Uint8Array([1, 2, 3]) };
		}
	};
}

const base = {
	bytes: new Uint8Array([9]),
	filename: "a.png",
	rightsAttested: true,
	intervalMs: 1,
};

test("clean runs upload, identify, process, poll, download", async () => {
	const m = mock(happyPath());
	const client = new DemarkerClient({
		apiKey: "sk_live_x",
		baseUrl: BASE,
		fetch: m.fetchImpl,
	});
	const res = await client.clean({ ...base, maxCredits: 1 });
	assert.deepEqual([...res.image], [1, 2, 3]);
	assert.equal(res.creditsCharged, 1);
	const process = m.calls.find((c) => c.url.endsWith("/process"));
	assert.deepEqual(process?.body, {
		tier: "GPU",
		keepResolution: false,
		rightsAttested: true,
	});
	// The presigned PUT carries no bearer token.
	assert.equal(
		m.calls.find((c) => c.url === "https://r2.example/put")?.headers
			.Authorization,
		undefined,
	);
});

test("clean refuses to spend when the offer is over maxCredits", async () => {
	const m = mock(happyPath());
	const client = new DemarkerClient({
		apiKey: "sk_live_x",
		baseUrl: BASE,
		fetch: m.fetchImpl,
	});
	await assert.rejects(
		client.clean({ ...base, maxCredits: 1, keepResolution: true }),
		(e: DemarkerClientError) =>
			e.code === "OVER_CREDIT_CAP" && e.details.requiredCredits === 2,
	);
	assert.equal(
		m.calls.some((c) => c.url.endsWith("/process")),
		false,
	);
});

test("clean requires maxCredits and an explicit attestation before any request", async () => {
	const m = mock(() => undefined);
	const client = new DemarkerClient({
		apiKey: "sk_live_x",
		baseUrl: BASE,
		fetch: m.fetchImpl,
	});
	await assert.rejects(
		client.clean({ ...base, maxCredits: Number.NaN }),
		(e: DemarkerClientError) => e.code === "CREDIT_CAP_REQUIRED",
	);
	await assert.rejects(
		client.clean({ ...base, maxCredits: 1, rightsAttested: false }),
		(e: DemarkerClientError) => e.code === "ATTESTATION_REQUIRED",
	);
	assert.equal(m.calls.length, 0);
});

test("a REFUSED identify stops with no process call", async () => {
	const m = mock(
		happyPath((c) =>
			c.url.endsWith("/identify")
				? {
						json: job({
							status: "REFUSED",
							refusalReason: "NSFW",
							offers: null,
						}),
					}
				: undefined,
		),
	);
	const client = new DemarkerClient({
		apiKey: "sk_live_x",
		baseUrl: BASE,
		fetch: m.fetchImpl,
	});
	await assert.rejects(
		client.clean({ ...base, maxCredits: 5 }),
		(e: DemarkerClientError) => e.code === "REFUSED",
	);
	assert.equal(
		m.calls.some((c) => c.url.endsWith("/process")),
		false,
	);
});

test("a 202 from identify is polled until the job settles", async () => {
	let polls = 0;
	const m = mock(
		happyPath((c) => {
			if (c.url.endsWith("/identify")) {
				return {
					status: 202,
					json: { id: "job1", status: "IDENTIFYING" },
				};
			}
			if (c.url.endsWith("/jobs/job1") && polls++ < 2) {
				return { json: job({ status: "IDENTIFYING" }) };
			}
			if (c.url.endsWith("/jobs/job1") && polls === 3) {
				return { json: job() };
			}
		}),
	);
	const client = new DemarkerClient({
		apiKey: "sk_live_x",
		baseUrl: BASE,
		fetch: m.fetchImpl,
	});
	const j = await client.identifyBytes(new Uint8Array([1]), "a.png", {
		intervalMs: 1,
	});
	assert.equal(j.status, "IDENTIFIED");
});

test("a lost process response (409) resolves to the running job, not a second debit", async () => {
	const m = mock(
		happyPath((c) => {
			if (c.url.endsWith("/process")) {
				return {
					status: 409,
					json: {
						error: {
							code: "JOB_NOT_IDENTIFIED",
							message: "changed",
						},
					},
				};
			}
			if (c.url.endsWith("/jobs/job1")) {
				return {
					json: job({
						status: "COMPLETED",
						creditsCharged: 1,
						outputs: { image: "https://r2.example/out.png" },
					}),
				};
			}
		}),
	);
	const client = new DemarkerClient({
		apiKey: "sk_live_x",
		baseUrl: BASE,
		fetch: m.fetchImpl,
	});
	const res = await client.clean({ ...base, maxCredits: 1 });
	assert.equal(res.job.status, "COMPLETED");
});

test("API errors keep code, message and extra fields", async () => {
	const m = mock(() => ({
		status: 402,
		json: {
			error: {
				code: "INSUFFICIENT_CREDITS",
				message: "Not enough",
				requiredCredits: 1,
				balance: 0,
				purchaseUrl: "https://demarker.io/app/credits",
				resolution: "Buy credits",
			},
		},
	}));
	const client = new DemarkerClient({
		apiKey: "sk_live_x",
		baseUrl: BASE,
		fetch: m.fetchImpl,
	});
	await assert.rejects(
		client.processJob("job1", { tier: "GPU", rightsAttested: true }),
		(e: DemarkerApiError) =>
			e.status === 402 &&
			e.code === "INSUFFICIENT_CREDITS" &&
			e.details.balance === 0 &&
			e.resolution === "Buy credits",
	);
});

test("processJob will not send without an explicit attestation", () => {
	const client = new DemarkerClient({
		apiKey: "sk_live_x",
		baseUrl: BASE,
		fetch: mock(() => undefined).fetchImpl,
	});
	assert.throws(
		() => client.processJob("job1", { tier: "GPU", rightsAttested: false }),
		(e: DemarkerClientError) => e.code === "ATTESTATION_REQUIRED",
	);
});

test("DEMARKER_API_URL overrides the default base URL", () => {
	process.env.DEMARKER_API_URL = "http://localhost:3300/api/v1/";
	const client = new DemarkerClient({ apiKey: "sk_live_x" });
	delete process.env.DEMARKER_API_URL;
	assert.equal(client.baseUrl, "http://localhost:3300/api/v1");
});

test("scan is keyless: multipart upload, token in a header, polled until settled", async () => {
	let polls = 0;
	const m = mock((c) => {
		if (c.url.endsWith("/scan")) {
			return {
				status: 202,
				json: {
					id: "s1",
					claimToken: "tok-secret-1",
					status: "UPLOADED",
					width: 1,
					height: 1,
					megapixels: 0,
					identifyOnly: false,
				},
			};
		}
		if (c.url.endsWith("/scan/s1")) {
			return {
				json: job({
					id: "s1",
					status: polls++ < 1 ? "IDENTIFYING" : "IDENTIFIED",
					balance: undefined,
				}),
			};
		}
	});
	const client = new DemarkerClient({ baseUrl: BASE, fetch: m.fetchImpl });
	const j = await client.scanBytes(new Uint8Array([1, 2]), "a.png", {
		intervalMs: 1,
	});
	assert.equal(j.status, "IDENTIFIED");
	const up = m.calls[0];
	assert.ok(up?.body instanceof FormData);
	assert.equal(up?.headers.Authorization, undefined);
	assert.equal(up?.headers["Content-Type"], undefined);
	for (const c of m.calls.slice(1)) {
		assert.equal(c.headers["X-Claim-Token"], "tok-secret-1");
		assert.equal(c.url.includes("tok-secret-1"), false);
	}
});

test("authenticated calls without a key fail before any request", async () => {
	const m = mock(() => undefined);
	const client = new DemarkerClient({ baseUrl: BASE, fetch: m.fetchImpl });
	await assert.rejects(
		client.getBalance(),
		(e: DemarkerClientError) => e.code === "NO_API_KEY",
	);
	assert.equal(m.calls.length, 0);
});
