#!/usr/bin/env node
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
	DemarkerApiError,
	DemarkerClient,
	DemarkerClientError,
	type Job,
} from "@demarker/client";
import { confirmRights } from "./attest.ts";
import {
	clearConfig,
	readConfig,
	resolveCredentials,
	writeConfig,
} from "./config.ts";
import { EXIT, exitCodeFor, UsageError } from "./exit.ts";
import { detectExt, outputPathFor } from "./files.ts";

const VERSION = "0.1.2";

const HELP = `demarker ${VERSION} - identify what an AI image carries, then clean it

Usage:
  demarker identify <file...>            Free, no key needed. Show what each image carries and what a clean costs.
  demarker clean <file...> --max-credits <n> --attest-rights [options]
  demarker balance                       Credit balance
  demarker pricing                       Price table and packs (no key needed)
  demarker login | logout                Store or remove an API key (~/.config/demarker)

Clean options:
  --max-credits <n>    Required. Total credits you allow this run to spend. Nothing is charged
                       if a quote is over what is left of it.
  --attest-rights      Confirm the rights statement. Required with --json or without a terminal.
  --tier GPU|QUICK     Default GPU. (QUICK is not sold through the API yet.)
  --keep-resolution    Keep original size above 12 MP (costs more).
  --vendor <name>      Where the image was made, when identify finds no hidden target.
  --out <path|dir>     Output file, or a directory for several files. Default: <name>.clean.<ext>
  --overwrite          Replace an existing output file.
  --timeout <seconds>  Give up waiting for a job after this long. Default 600.

Global options:
  --json               Machine-readable output on stdout, progress off.
  --help, --version

Environment:
  DEMARKER_API_KEY     API key (sk_live_...). Create one at https://demarker.io/app/settings/api
  DEMARKER_API_URL     API base URL. Default https://demarker.io/api/v1

Exit codes:
  0 ok  1 error  2 usage  3 auth  4 credits (insufficient or over cap)
  5 rejected (refused image, bad input)  6 region blocked  7 job failed or timed out  8 network/server
`;

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

async function makeClient(): Promise<DemarkerClient> {
	const { apiKey, baseUrl } = await resolveCredentials();
	if (!apiKey) {
		throw new UsageError(
			"No API key. Run `demarker login`, or set DEMARKER_API_KEY. Create a key at https://demarker.io/app/settings/api",
		);
	}
	return new DemarkerClient({
		apiKey,
		baseUrl,
		userAgent: `demarker-cli/${VERSION}`,
	});
}

async function readImage(path: string): Promise<Uint8Array> {
	const s = await stat(path).catch(() => null);
	if (!s?.isFile()) {
		throw new UsageError(`Not a file: ${path}`);
	}
	return new Uint8Array(await readFile(path));
}

function summarize(path: string, job: Job): string {
	const lines = [
		`${path}  (${job.width}x${job.height}, ${job.megapixels.toFixed(1)} MP)`,
	];
	if (job.status === "REFUSED") {
		lines.push(`  refused: ${job.refusalReason ?? "unspecified"}`);
		return lines.join("\n");
	}
	lines.push(
		`  vendor: ${job.vendor ?? "unknown"}   hidden watermark target: ${job.hasInvisibleTarget ? "yes (inferred)" : "none found"}`,
	);
	for (const o of job.offers ?? []) {
		lines.push(
			`  ${o.tier}${o.keepResolution ? " (original size)" : ""}: ${o.credits} credit${o.credits === 1 ? "" : "s"}`,
		);
	}
	if (job.balance !== undefined) {
		lines.push(`  balance: ${job.balance} credits`);
	}
	return lines.join("\n");
}

async function cmdIdentify(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { json: { type: "boolean" }, timeout: { type: "string" } },
	});
	if (!positionals.length) {
		throw new UsageError("identify needs at least one file.");
	}
	// With no key this is a keyless scan: same free identify, but cleaning needs a key.
	const { apiKey, baseUrl } = await resolveCredentials();
	const keyless = !apiKey;
	const client = new DemarkerClient({
		apiKey,
		baseUrl,
		userAgent: `demarker-cli/${VERSION}`,
	});
	const timeoutMs = Number(values.timeout ?? 120) * 1000;
	const results: unknown[] = [];
	let refused = false;
	for (const file of positionals) {
		const bytes = await readImage(file);
		const job = keyless
			? await client.scanBytes(bytes, basename(file), { timeoutMs })
			: await client.identifyBytes(bytes, basename(file), { timeoutMs });
		results.push({ file, job });
		if (job.status === "REFUSED") {
			refused = true;
		}
		if (!values.json) {
			out(summarize(file, job));
		}
	}
	if (values.json) {
		out(
			JSON.stringify(
				results.length === 1 ? results[0] : results,
				null,
				2,
			),
		);
	} else if (keyless) {
		err(
			"No API key set, so this was a keyless scan. To clean, get a key at https://demarker.io/app/settings/api",
		);
	}
	// Identify never spends credits, so the jobs just expire (originals deleted after 24 h).
	return refused ? EXIT.REJECTED : EXIT.OK;
}

async function cmdClean(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			json: { type: "boolean" },
			"max-credits": { type: "string" },
			"attest-rights": { type: "boolean" },
			tier: { type: "string" },
			"keep-resolution": { type: "boolean" },
			vendor: { type: "string" },
			out: { type: "string" },
			overwrite: { type: "boolean" },
			timeout: { type: "string" },
		},
	});
	if (!positionals.length) {
		throw new UsageError("clean needs at least one file.");
	}
	if (values["max-credits"] === undefined) {
		throw new UsageError(
			"--max-credits <n> is required. It is the most this run may spend; nothing is charged above it.",
		);
	}
	const budget = Number(values["max-credits"]);
	if (!(Number.isFinite(budget) && budget >= 0)) {
		throw new UsageError("--max-credits must be a number, 0 or more.");
	}
	const tier = (values.tier ?? "GPU").toUpperCase();
	if (tier !== "GPU" && tier !== "QUICK") {
		throw new UsageError("--tier must be GPU or QUICK.");
	}
	const json = values.json === true;
	if (positionals.length > 1 && values.out) {
		const s = await stat(values.out).catch(() => null);
		if (!s?.isDirectory()) {
			throw new UsageError(
				"With several files, --out must be an existing directory.",
			);
		}
	}

	await confirmRights(values["attest-rights"] === true, json);
	const client = await makeClient();
	const timeoutMs = Number(values.timeout ?? 600) * 1000;

	const outIsDir = values.out
		? (await stat(values.out).catch(() => null))?.isDirectory() === true
		: false;
	const outPath = async (file: string, ext: string) =>
		outputPathFor(file, ext, values.out, outIsDir);
	const exists = (p: string) =>
		access(p).then(
			() => true,
			() => false,
		);
	// The clean is paid for by now, so never drop the result: on a late collision write beside it.
	const freeTarget = async (
		file: string,
		image: Uint8Array,
		jobId: string,
	) => {
		const p = await outPath(file, detectExt(image));
		if (values.overwrite || !(await exists(p))) {
			return p;
		}
		const alt = p.replace(/(\.[a-z]+)$/, `.${jobId.slice(0, 8)}$1`);
		err(`${p} appeared during the run; saving to ${alt}`);
		return alt;
	};

	let remaining = budget;
	let spent = 0;
	const results: {
		file: string;
		output: string;
		jobId: string;
		creditsCharged: number;
	}[] = [];
	for (const file of positionals) {
		const bytes = await readImage(file);
		// Refuse before spending if the result would land on an existing file.
		if (!values.overwrite) {
			for (const ext of [".png", ".jpg", ".webp"]) {
				const p = await outPath(file, ext);
				if (await exists(p)) {
					throw new UsageError(
						`${p} already exists. Use --overwrite or choose another --out. Nothing was charged.`,
					);
				}
			}
		}
		if (!json) {
			err(`${file}: uploading and identifying...`);
		}
		let lastStatus = "";
		const res = await client.clean({
			bytes,
			filename: basename(file),
			tier,
			maxCredits: remaining,
			rightsAttested: true,
			keepResolution: values["keep-resolution"] === true,
			vendorHint: values.vendor,
			timeoutMs,
			onIdentified: (job) => {
				const offer = job.offers?.find(
					(o) =>
						o.tier === tier &&
						o.keepResolution ===
							(values["keep-resolution"] === true),
				);
				if (!json && offer) {
					err(
						`${file}: ${offer.credits} credit(s), ${remaining} left of your cap. Processing...`,
					);
				}
			},
			onProgress: (job) => {
				if (!json && job.status !== lastStatus) {
					lastStatus = job.status;
					err(`${file}: ${job.status.toLowerCase()}`);
				}
			},
		});
		const target = await freeTarget(file, res.image, res.job.id);
		await writeFile(target, res.image);
		remaining -= res.creditsCharged;
		spent += res.creditsCharged;
		results.push({
			file,
			output: target,
			jobId: res.job.id,
			creditsCharged: res.creditsCharged,
		});
		if (!json) {
			err(`${file}: done, ${res.creditsCharged} credit(s)`);
			out(target);
		}
	}
	if (json) {
		out(JSON.stringify({ results, creditsCharged: spent }, null, 2));
	}
	return EXIT.OK;
}

async function cmdBalance(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: { json: { type: "boolean" } },
	});
	const b = await (await makeClient()).getBalance();
	out(values.json ? JSON.stringify(b) : `${b.balanceCredits} credits`);
	return EXIT.OK;
}

async function cmdPricing(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: { json: { type: "boolean" } },
	});
	const { baseUrl } = await resolveCredentials();
	const p = await new DemarkerClient({
		apiKey: "none",
		baseUrl,
	}).getPricing();
	if (values.json) {
		out(JSON.stringify(p, null, 2));
		return EXIT.OK;
	}
	out(p.unit);
	out(
		`GPU: ${p.tiers.GPU.standardOutput} credit up to ${p.bandMegapixels} MP, ${p.tiers.GPU.originalOverBand} at original size above that.`,
	);
	for (const pack of p.packs) {
		out(
			`  ${pack.label}: ${pack.credits} credit(s) for $${(pack.priceCents / 100).toFixed(2)}`,
		);
	}
	return EXIT.OK;
}

async function cmdLogin() {
	if (!process.stdin.isTTY) {
		throw new UsageError(
			"login needs a terminal. In scripts, set DEMARKER_API_KEY instead.",
		);
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	let key: string;
	try {
		key = (await rl.question("API key (sk_live_...): ")).trim();
	} finally {
		rl.close();
	}
	if (!key.startsWith("sk_live_")) {
		throw new UsageError("API keys start with sk_live_.");
	}
	const { baseUrl } = await resolveCredentials();
	const bal = await new DemarkerClient({ apiKey: key, baseUrl }).getBalance(); // proves the key works
	const file = await writeConfig({ ...(await readConfig()), apiKey: key });
	err(`Saved to ${file} (mode 600). Balance: ${bal.balanceCredits} credits.`);
	return EXIT.OK;
}

async function cmdLogout() {
	await clearConfig();
	err("Removed the stored API key.");
	return EXIT.OK;
}

function reportError(e: unknown, json: boolean) {
	const code = exitCodeFor(e);
	let body: Record<string, unknown>;
	if (e instanceof DemarkerApiError) {
		body = {
			code: e.code,
			message: e.message,
			status: e.status,
			...e.details,
		};
	} else if (e instanceof DemarkerClientError) {
		body = { code: e.code, message: e.message, ...e.details };
	} else if (e instanceof UsageError) {
		body = { code: "USAGE", message: e.message };
	} else if (e instanceof TypeError) {
		body = {
			code: "NETWORK",
			message: `Could not reach the API: ${(e.cause as Error | undefined)?.message ?? e.message}`,
		};
	} else {
		body = {
			code: "ERROR",
			message: e instanceof Error ? e.message : String(e),
		};
	}
	if (json) {
		out(JSON.stringify({ error: body }));
	} else {
		err(`error: ${body.message}`);
		if (typeof body.resolution === "string") {
			err(`  ${body.resolution}`);
		}
		if (typeof body.purchaseUrl === "string") {
			err(`  Buy credits: ${body.purchaseUrl}`);
		}
	}
	return code;
}

async function main(): Promise<number> {
	const [cmd, ...rest] = process.argv.slice(2);
	if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
		out(HELP);
		return EXIT.OK;
	}
	if (cmd === "--version" || cmd === "-v") {
		out(VERSION);
		return EXIT.OK;
	}
	const json = rest.includes("--json");
	try {
		switch (cmd) {
			case "identify":
				return await cmdIdentify(rest);
			case "clean":
				return await cmdClean(rest);
			case "balance":
				return await cmdBalance(rest);
			case "pricing":
				return await cmdPricing(rest);
			case "login":
				return await cmdLogin();
			case "logout":
				return await cmdLogout();
			default:
				throw new UsageError(
					`Unknown command: ${cmd}. Run \`demarker --help\`.`,
				);
		}
	} catch (e) {
		return reportError(e, json);
	}
}

process.exitCode = await main();
