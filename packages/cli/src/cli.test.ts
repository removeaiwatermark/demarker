import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DemarkerApiError, DemarkerClientError } from "@demarker/client";
import { EXIT, exitCodeFor, UsageError } from "./exit.ts";
import { detectExt, outputPathFor } from "./files.ts";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

let server: Server;
let base = "";
let calls: string[] = [];
let credits = 1;

const jobBody = (over: Record<string, unknown> = {}) => ({
	id: "job12345abc",
	status: "IDENTIFIED",
	progress: null,
	width: 100,
	height: 100,
	megapixels: 0.01,
	band: "small",
	hasInvisibleTarget: true,
	vendor: "google",
	report: {},
	cmiFields: null,
	offers: [{ tier: "GPU", keepResolution: false, credits }],
	balance: 3,
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

async function body(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const c of req) {
		chunks.push(c as Buffer);
	}
	return Buffer.concat(chunks).toString();
}

before(async () => {
	server = createServer(async (req, res) => {
		const url = req.url ?? "";
		calls.push(`${req.method} ${url}`);
		await body(req);
		const json = (status: number, data: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(data));
		};
		if (url === "/api/v1/upload") {
			return json(200, {
				uploadUrl: `${base}/put`,
				uploadKey: "uploads/api_x/input.png",
				expiresAt: "",
				maxFileSizeBytes: 1,
				maxFileSizeMb: 1,
				contentType: "image/png",
			});
		}
		if (url === "/put") {
			res.writeHead(200);
			return res.end();
		}
		if (url === "/api/v1/identify") {
			return json(200, jobBody());
		}
		if (url.endsWith("/process")) {
			return json(
				200,
				jobBody({ status: "PENDING", creditsCharged: credits }),
			);
		}
		if (url === "/api/v1/jobs/job12345abc") {
			return json(
				200,
				jobBody({
					status: "COMPLETED",
					creditsCharged: credits,
					outputs: { image: `${base}/out.png` },
				}),
			);
		}
		if (url === "/out.png") {
			res.writeHead(200);
			return res.end(Buffer.from(PNG));
		}
		if (url === "/api/v1/scan") {
			return json(202, {
				id: "scan1",
				claimToken: "tok-12345678",
				status: "UPLOADED",
				width: 100,
				height: 100,
				megapixels: 0.01,
				identifyOnly: false,
			});
		}
		if (url === "/api/v1/scan/scan1") {
			return json(200, jobBody({ id: "scan1", balance: undefined }));
		}
		if (url === "/api/v1/balance") {
			return json(200, { balanceCredits: 3, updatedAt: "" });
		}
		json(404, { error: { code: "NOT_FOUND", message: "nope" } });
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

function run(args: string[], env: Record<string, string> = {}) {
	return new Promise<{ code: number; stdout: string; stderr: string }>(
		(resolve) => {
			const p = spawn(process.execPath, [CLI, ...args], {
				env: {
					PATH: process.env.PATH ?? "",
					HOME: tmpdir(),
					XDG_CONFIG_HOME: join(tmpdir(), "demarker-test-none"),
					DEMARKER_API_URL: `${base}/api/v1`,
					DEMARKER_API_KEY: "sk_live_test",
					...env,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			p.stdout.on("data", (d) => {
				stdout += d;
			});
			p.stderr.on("data", (d) => {
				stderr += d;
			});
			p.on("close", (code) =>
				resolve({ code: code ?? -1, stdout, stderr }),
			);
		},
	);
}

test("clean: writes <name>.clean.png, prints its path, charges what was quoted", async () => {
	calls = [];
	credits = 1;
	const dir = await mkdtemp(join(tmpdir(), "dm-"));
	const f = join(dir, "photo.png");
	await writeFile(f, PNG);
	const r = await run(["clean", f, "--max-credits", "1", "--attest-rights"]);
	assert.equal(r.code, EXIT.OK, r.stderr);
	assert.equal(r.stdout.trim(), join(dir, "photo.clean.png"));
	assert.deepEqual(
		[...(await readFile(join(dir, "photo.clean.png")))],
		[...PNG],
	);
});

test("clean --json: structured result, nothing else on stdout", async () => {
	credits = 1;
	const dir = await mkdtemp(join(tmpdir(), "dm-"));
	const f = join(dir, "a.png");
	await writeFile(f, PNG);
	const r = await run([
		"clean",
		f,
		"--max-credits",
		"2",
		"--attest-rights",
		"--json",
	]);
	assert.equal(r.code, EXIT.OK, r.stderr);
	const j = JSON.parse(r.stdout);
	assert.equal(j.creditsCharged, 1);
	assert.equal(j.results[0].jobId, "job12345abc");
});

test("clean: over the cap exits 4 and never calls process", async () => {
	calls = [];
	credits = 2;
	const dir = await mkdtemp(join(tmpdir(), "dm-"));
	const f = join(dir, "b.png");
	await writeFile(f, PNG);
	const r = await run(["clean", f, "--max-credits", "1", "--attest-rights"]);
	assert.equal(r.code, EXIT.CREDITS);
	assert.equal(
		calls.some((c) => c.endsWith("/process")),
		false,
	);
});

test("clean: no terminal and no --attest-rights is a usage error before any request", async () => {
	calls = [];
	const dir = await mkdtemp(join(tmpdir(), "dm-"));
	const f = join(dir, "c.png");
	await writeFile(f, PNG);
	const r = await run(["clean", f, "--max-credits", "1"]);
	assert.equal(r.code, EXIT.USAGE);
	assert.equal(calls.length, 0);
});

test("clean: refuses to overwrite before spending", async () => {
	calls = [];
	credits = 1;
	const dir = await mkdtemp(join(tmpdir(), "dm-"));
	const f = join(dir, "d.png");
	await writeFile(f, PNG);
	await writeFile(join(dir, "d.clean.png"), "keep me");
	const r = await run(["clean", f, "--max-credits", "1", "--attest-rights"]);
	assert.equal(r.code, EXIT.USAGE);
	assert.equal(calls.length, 0);
	assert.equal(await readFile(join(dir, "d.clean.png"), "utf8"), "keep me");
});

test("identify prints the quote and does not process", async () => {
	calls = [];
	credits = 1;
	const dir = await mkdtemp(join(tmpdir(), "dm-"));
	const f = join(dir, "e.png");
	await writeFile(f, PNG);
	const r = await run(["identify", f]);
	assert.equal(r.code, EXIT.OK, r.stderr);
	assert.match(r.stdout, /GPU: 1 credit/);
	assert.equal(
		calls.some((c) => c.endsWith("/process")),
		false,
	);
});

test("identify with no key does a keyless scan and uses no bearer token", async () => {
	calls = [];
	credits = 1;
	const dir = await mkdtemp(join(tmpdir(), "dm-"));
	const f = join(dir, "k.png");
	await writeFile(f, PNG);
	const r = await run(["identify", f], { DEMARKER_API_KEY: "" });
	assert.equal(r.code, EXIT.OK, r.stderr);
	assert.match(r.stdout, /GPU: 1 credit/);
	assert.match(r.stderr, /keyless scan/);
	assert.deepEqual(calls, ["POST /api/v1/scan", "GET /api/v1/scan/scan1"]);
});

test("no key set is a usage error (exit 2)", async () => {
	assert.equal(
		(await run(["balance"], { DEMARKER_API_KEY: "" })).code,
		EXIT.USAGE,
	);
});

test("exit code mapping", () => {
	assert.equal(
		exitCodeFor(new DemarkerApiError(402, "INSUFFICIENT_CREDITS", "x")),
		EXIT.CREDITS,
	);
	assert.equal(
		exitCodeFor(new DemarkerApiError(451, "REGION_BLOCKED", "x")),
		EXIT.REGION,
	);
	assert.equal(
		exitCodeFor(new DemarkerApiError(401, "INVALID_API_KEY", "x")),
		EXIT.AUTH,
	);
	assert.equal(
		exitCodeFor(new DemarkerApiError(422, "OFFER_NOT_AVAILABLE", "x")),
		EXIT.REJECTED,
	);
	assert.equal(
		exitCodeFor(new DemarkerClientError("TIMEOUT", "x")),
		EXIT.JOB_FAILED,
	);
	assert.equal(exitCodeFor(new UsageError("x")), EXIT.USAGE);
});

test("file helpers", () => {
	assert.equal(detectExt(new Uint8Array([0xff, 0xd8, 0xff])), ".jpg");
	assert.equal(outputPathFor("/a/p.jpeg", ".png"), "/a/p.clean.png");
	assert.equal(
		outputPathFor("/a/p.jpeg", ".png", "/out", true),
		"/out/p.clean.png",
	);
});
