import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DemarkerClient } from "@demarker/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createDemarkerServer } from "./tools.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const job = (over: Record<string, unknown> = {}) => ({
	id: "job12345abc",
	status: "IDENTIFIED",
	progress: null,
	width: 10,
	height: 10,
	megapixels: 0.0001,
	band: "small",
	hasInvisibleTarget: true,
	vendor: "google",
	report: {},
	cmiFields: null,
	offers: [{ tier: "GPU", keepResolution: false, credits: 2 }],
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
	createdAt: "",
	completedAt: null,
	expiresAt: null,
	...over,
});

function mockApi(creditsQuote = 2) {
	const calls: string[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		const json = (d: unknown, status = 200) =>
			new Response(JSON.stringify(d), { status });
		if (url.endsWith("/upload")) {
			return json({
				uploadUrl: "https://r2.test/put",
				uploadKey: "k",
				expiresAt: "",
				maxFileSizeBytes: 1,
				maxFileSizeMb: 1,
				contentType: "image/png",
			});
		}
		if (url === "https://r2.test/put") {
			return new Response("");
		}
		if (url.endsWith("/identify")) {
			return json(
				job({
					offers: [
						{
							tier: "GPU",
							keepResolution: false,
							credits: creditsQuote,
						},
					],
				}),
			);
		}
		if (url.endsWith("/process")) {
			return json(
				job({ status: "PENDING", creditsCharged: creditsQuote }),
			);
		}
		if (url.endsWith("/jobs/job12345abc")) {
			return json(
				job({
					status: "COMPLETED",
					creditsCharged: creditsQuote,
					outputs: { image: "https://r2.test/out" },
				}),
			);
		}
		if (url === "https://r2.test/out") {
			return new Response(PNG as BodyInit);
		}
		if (url.endsWith("/scan")) {
			return json(
				{
					id: "s1",
					claimToken: "tok-12345678",
					status: "UPLOADED",
					width: 1,
					height: 1,
					megapixels: 0,
					identifyOnly: false,
				},
				202,
			);
		}
		if (url.endsWith("/scan/s1")) {
			return json(job({ id: "s1" }));
		}
		return json({ error: { code: "NOT_FOUND", message: url } }, 404);
	}) as typeof fetch;
	return { calls, fetchImpl };
}

async function connect(opts: {
	apiKey?: string;
	elicit?: "accept" | "decline";
	ceiling?: number;
	quote?: number;
}) {
	const api = mockApi(opts.quote);
	const client = new DemarkerClient({
		apiKey: opts.apiKey,
		baseUrl: "https://x.test/api/v1",
		fetch: api.fetchImpl,
	});
	const server = createDemarkerServer({
		client,
		version: "0.0.0",
		maxCreditsPerCall: opts.ceiling ?? 2,
	});
	const mcp = new Client(
		{ name: "t", version: "0" },
		{ capabilities: opts.elicit ? { elicitation: {} } : {} },
	);
	let asked = 0;
	if (opts.elicit) {
		mcp.setRequestHandler(ElicitRequestSchema, async () => {
			asked++;
			return opts.elicit === "accept"
				? { action: "accept", content: { confirm: true } }
				: { action: "decline" };
		});
	}
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), mcp.connect(b)]);
	return { mcp, api, asked: () => asked };
}

async function image() {
	const dir = await mkdtemp(join(tmpdir(), "mcp-"));
	const path = join(dir, "p.png");
	await writeFile(path, PNG);
	return { dir, path };
}

const spent = (calls: string[]) => calls.some((c) => c.endsWith("/process"));

test("lists the tools, with the spending one not read-only", async () => {
	const { mcp } = await connect({ apiKey: "sk_live_x" });
	const { tools } = await mcp.listTools();
	assert.deepEqual(tools.map((t) => t.name).sort(), [
		"demarker_clean",
		"demarker_get_balance",
		"demarker_get_job",
		"demarker_get_pricing",
		"demarker_identify",
	]);
	assert.equal(
		tools.find((t) => t.name === "demarker_clean")?.annotations
			?.readOnlyHint,
		false,
	);
	assert.equal(
		tools.find((t) => t.name === "demarker_identify")?.annotations
			?.readOnlyHint,
		true,
	);
});

test("identify with no key uses the keyless scan", async () => {
	const { mcp, api } = await connect({});
	const { path } = await image();
	const r = await mcp.callTool({
		name: "demarker_identify",
		arguments: { path },
	});
	assert.notEqual(r.isError, true);
	assert.deepEqual(api.calls.filter((c) => c.includes("/scan")).length, 2);
	assert.match(JSON.stringify(r.content), /GPU: 2 credit/);
});

test("clean without a way to ask the user and without rightsAttested spends nothing", async () => {
	const { mcp, api } = await connect({ apiKey: "sk_live_x" });
	const { path } = await image();
	const r = await mcp.callTool({
		name: "demarker_clean",
		arguments: { path, maxCredits: 5 },
	});
	assert.equal(r.isError, true);
	assert.match(JSON.stringify(r.content), /user must confirm/);
	assert.equal(api.calls.length, 0);
});

test("clean: a declined confirmation spends nothing even if the model passed rightsAttested", async () => {
	const { mcp, api, asked } = await connect({
		apiKey: "sk_live_x",
		elicit: "decline",
	});
	const { path } = await image();
	const r = await mcp.callTool({
		name: "demarker_clean",
		arguments: { path, maxCredits: 5, rightsAttested: true },
	});
	assert.equal(r.isError, true);
	assert.equal(asked(), 1);
	assert.equal(api.calls.length, 0);
});

test("clean: confirmed by the user, saves <name>.clean.png and reports the charge", async () => {
	const { mcp, asked } = await connect({
		apiKey: "sk_live_x",
		elicit: "accept",
		quote: 1,
	});
	const { path, dir } = await image();
	const r = await mcp.callTool({
		name: "demarker_clean",
		arguments: { path, maxCredits: 1 },
	});
	assert.notEqual(r.isError, true, JSON.stringify(r.content));
	assert.equal(asked(), 1);
	assert.deepEqual([...(await readFile(join(dir, "p.clean.png")))], [...PNG]);
	assert.deepEqual(
		(r.structuredContent as { creditsCharged: number }).creditsCharged,
		1,
	);
});

test("clean: the server ceiling beats a larger maxCredits from the model", async () => {
	const { mcp, api } = await connect({
		apiKey: "sk_live_x",
		elicit: "accept",
		ceiling: 1,
		quote: 2,
	});
	const { path } = await image();
	const r = await mcp.callTool({
		name: "demarker_clean",
		arguments: { path, maxCredits: 50 },
	});
	assert.equal(r.isError, true);
	assert.match(JSON.stringify(r.content), /OVER_CREDIT_CAP/);
	assert.equal(spent(api.calls), false);
});

test("clean: refuses to overwrite before spending", async () => {
	const { mcp, api } = await connect({
		apiKey: "sk_live_x",
		elicit: "accept",
		quote: 1,
	});
	const { path, dir } = await image();
	await writeFile(join(dir, "p.clean.png"), "keep");
	const r = await mcp.callTool({
		name: "demarker_clean",
		arguments: { path, maxCredits: 1 },
	});
	assert.equal(r.isError, true);
	assert.equal(api.calls.length, 0);
	assert.equal(await readFile(join(dir, "p.clean.png"), "utf8"), "keep");
});

test("clean and balance without a key explain how to set one", async () => {
	const { mcp } = await connect({ elicit: "accept" });
	const { path } = await image();
	for (const [name, args] of [
		["demarker_clean", { path, maxCredits: 1 }],
		["demarker_get_balance", {}],
	] as const) {
		const r = await mcp.callTool({ name, arguments: args });
		assert.equal(r.isError, true);
		assert.match(JSON.stringify(r.content), /DEMARKER_API_KEY/);
	}
});
