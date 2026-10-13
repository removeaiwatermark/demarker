import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	ATTESTATION_TEXT,
	ATTESTATION_VERSION,
	DemarkerApiError,
	type DemarkerClient,
	DemarkerClientError,
	detectExt,
	type Job,
	outputPathFor,
} from "@demarker/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ServerOptions {
	client: DemarkerClient;
	version: string;
	/**
	 * Hard ceiling on credits one `demarker_clean` call may spend, whatever the
	 * model asks for. Protects an unattended agent. Set DEMARKER_MCP_MAX_CREDITS.
	 */
	maxCreditsPerCall: number;
}

type ToolResult = {
	content: { type: "text"; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

const text = (t: string, structured?: Record<string, unknown>): ToolResult => ({
	content: [{ type: "text", text: t }],
	...(structured ? { structuredContent: structured } : {}),
});
const fail = (t: string, structured?: Record<string, unknown>): ToolResult => ({
	...text(t, structured),
	isError: true,
});

const NEEDS_KEY =
	"This needs an API key. Set DEMARKER_API_KEY in the MCP server's environment (create one at https://demarker.io/app/settings/api).";

function errorResult(e: unknown): ToolResult {
	if (e instanceof DemarkerApiError) {
		const bits = [`${e.code}: ${e.message}`];
		if (e.resolution) {
			bits.push(e.resolution);
		}
		if (typeof e.details.purchaseUrl === "string") {
			bits.push(`Buy credits: ${e.details.purchaseUrl}`);
		}
		return fail(bits.join("\n"), {
			code: e.code,
			status: e.status,
			...e.details,
		});
	}
	if (e instanceof DemarkerClientError) {
		return fail(`${e.code}: ${e.message}`, { code: e.code, ...e.details });
	}
	if (e instanceof TypeError) {
		return fail(`Could not reach the Demarker API: ${e.message}`);
	}
	return fail(e instanceof Error ? e.message : String(e));
}

/** A compact, model-friendly view of a job. Never includes URLs or tokens. */
export function summarizeJob(job: Job) {
	return {
		jobId: job.id,
		status: job.status,
		width: job.width,
		height: job.height,
		megapixels: Number(job.megapixels.toFixed(2)),
		vendor: job.vendor,
		hiddenWatermarkTarget: job.hasInvisibleTarget,
		offers: (job.offers ?? []).map((o) => ({
			tier: o.tier,
			keepResolution: o.keepResolution,
			credits: o.credits,
		})),
		refusalReason: job.refusalReason,
		creditsCharged: job.creditsCharged,
		report: job.report,
	};
}

async function readImage(path: string): Promise<Uint8Array> {
	const s = await stat(path).catch(() => null);
	if (!s?.isFile()) {
		throw new DemarkerClientError("UPLOAD_FAILED", `Not a file: ${path}`);
	}
	return new Uint8Array(await readFile(path));
}

const exists = (p: string) =>
	access(p).then(
		() => true,
		() => false,
	);

export function createDemarkerServer(options: ServerOptions): McpServer {
	const { client } = options;
	const server = new McpServer(
		{ name: "demarker", version: options.version },
		{
			instructions:
				"Demarker identifies what an AI-generated image carries (visible marks, AI metadata, inferred hidden watermarks), then cleans it. " +
				"Start with demarker_identify (free). Only call demarker_clean when the user has asked to clean the image; it spends credits and requires the user's own confirmation of the rights statement. " +
				"Never set rightsAttested yourself unless the user has explicitly said yes to the statement shown to them.",
		},
	);

	server.registerTool(
		"demarker_identify",
		{
			title: "Identify an image (free)",
			description:
				"Free. Upload a local image and report what it carries: visible marks, AI metadata, inferred hidden watermarks, and the credit price of a clean. Works without an API key (keyless scan, rate-limited). Spends nothing.",
			inputSchema: {
				path: z
					.string()
					.describe(
						"Absolute path to a PNG, JPG, WebP or AVIF file.",
					),
			},
			annotations: {
				readOnlyHint: true,
				openWorldHint: true,
				idempotentHint: false,
			},
		},
		async ({ path }): Promise<ToolResult> => {
			try {
				const bytes = await readImage(path);
				const job = client.hasApiKey
					? await client.identifyBytes(bytes, basename(path))
					: await client.scanBytes(bytes, basename(path));
				const s = summarizeJob(job);
				const lines = [
					`${basename(path)}: ${s.width}x${s.height} (${s.megapixels} MP), status ${s.status}.`,
				];
				if (s.status === "REFUSED") {
					lines.push(`Refused: ${s.refusalReason ?? "unspecified"}.`);
				} else {
					lines.push(
						`Vendor: ${s.vendor ?? "unknown"}. Hidden watermark target: ${s.hiddenWatermarkTarget ? "yes (inferred)" : "none found"}.`,
						...s.offers.map(
							(o) =>
								`${o.tier}${o.keepResolution ? " at original size" : ""}: ${o.credits} credit(s).`,
						),
					);
					if (!client.hasApiKey) {
						lines.push(
							"Keyless scan: cleaning needs an API key (DEMARKER_API_KEY).",
						);
					}
				}
				return text(lines.join("\n"), s);
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	server.registerTool(
		"demarker_clean",
		{
			title: "Clean an image (spends credits)",
			description:
				"Spends credits. Identifies the image, checks the price against maxCredits (nothing is charged above it), runs the GPU clean, and saves the result next to the input as <name>.clean.<ext> (never overwrites). Needs DEMARKER_API_KEY. The user must confirm the rights statement: the client asks them when it supports it; otherwise pass rightsAttested true only after the user explicitly agreed to the statement.",
			inputSchema: {
				path: z.string().describe("Absolute path to the input image."),
				maxCredits: z
					.number()
					.int()
					.min(0)
					.describe(
						"The most this call may spend. Required. 1 credit is one clean up to 12 MP.",
					),
				rightsAttested: z
					.boolean()
					.optional()
					.describe(
						"True only if the user explicitly confirmed the rights statement. Ignored when the client can ask the user directly.",
					),
				keepResolution: z
					.boolean()
					.optional()
					.describe(
						"Keep original size above 12 MP (costs 2 credits).",
					),
				vendorHint: z
					.string()
					.optional()
					.describe(
						"Where the image was made, if identify found no hidden target.",
					),
				outputPath: z
					.string()
					.optional()
					.describe(
						"Where to save the result. Must not already exist.",
					),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (args, _extra): Promise<ToolResult> => {
			try {
				if (!client.hasApiKey) {
					return fail(NEEDS_KEY);
				}
				const cap = Math.min(
					args.maxCredits,
					options.maxCreditsPerCall,
				);

				// A human's yes, never the model's. Prefer asking the user directly.
				let attested = false;
				const canAsk = Boolean(
					server.server.getClientCapabilities()?.elicitation,
				);
				if (canAsk) {
					const res = await server.server.elicitInput({
						message: `Confirm to clean ${basename(args.path)} (up to ${cap} credit(s)).\n\n${ATTESTATION_TEXT}`,
						requestedSchema: {
							type: "object",
							properties: {
								confirm: {
									type: "boolean",
									title: `I confirm this statement (${ATTESTATION_VERSION})`,
								},
							},
							required: ["confirm"],
						},
					});
					attested =
						res.action === "accept" &&
						res.content?.confirm === true;
					if (!attested) {
						return fail(
							"The user did not confirm the rights statement. Nothing was uploaded or charged.",
						);
					}
				} else if (args.rightsAttested === true) {
					attested = true;
				} else {
					return fail(
						`The user must confirm this statement before a clean (${ATTESTATION_VERSION}):\n${ATTESTATION_TEXT}\nAsk them, and call again with rightsAttested true only if they agree. Nothing was charged.`,
					);
				}

				const bytes = await readImage(args.path);
				// Refuse before spending if the result would land on an existing file.
				const targets = args.outputPath
					? [args.outputPath]
					: [".png", ".jpg", ".webp"].map((e) =>
							outputPathFor(args.path, e),
						);
				for (const t of targets) {
					if (await exists(t)) {
						return fail(
							`${t} already exists. Choose another outputPath. Nothing was charged.`,
						);
					}
				}

				const res = await client.clean({
					bytes,
					filename: basename(args.path),
					tier: "GPU",
					maxCredits: cap,
					rightsAttested: attested,
					keepResolution: args.keepResolution === true,
					vendorHint: args.vendorHint,
				});
				let target =
					args.outputPath ??
					outputPathFor(args.path, detectExt(res.image));
				if (await exists(target)) {
					// Paid already: never lose the result.
					target = target.replace(
						/(\.[a-z]+)$/,
						`.${res.job.id.slice(0, 8)}$1`,
					);
				}
				await writeFile(target, res.image);
				return text(
					`Cleaned. Saved to ${target}. Charged ${res.creditsCharged} credit(s).`,
					{
						outputPath: target,
						creditsCharged: res.creditsCharged,
						jobId: res.job.id,
					},
				);
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	server.registerTool(
		"demarker_get_balance",
		{
			title: "Get credit balance",
			description:
				"Read the account's credit balance. Needs DEMARKER_API_KEY.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (): Promise<ToolResult> => {
			if (!client.hasApiKey) {
				return fail(NEEDS_KEY);
			}
			try {
				const b = await client.getBalance();
				return text(`${b.balanceCredits} credits.`, {
					balanceCredits: b.balanceCredits,
				});
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	server.registerTool(
		"demarker_get_pricing",
		{
			title: "Get pricing",
			description:
				"Credits per clean and the credit packs. Public, no key needed.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (): Promise<ToolResult> => {
			try {
				const p = await client.getPricing();
				return text(
					`${p.unit}\n${p.packs.map((k) => `${k.label}: ${k.credits} credit(s) for $${(k.priceCents / 100).toFixed(2)}`).join("\n")}`,
					p as unknown as Record<string, unknown>,
				);
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	server.registerTool(
		"demarker_get_job",
		{
			title: "Get a job",
			description:
				"Status and report for a job from demarker_identify or demarker_clean. Needs DEMARKER_API_KEY.",
			inputSchema: { jobId: z.string().describe("The jobId.") },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ jobId }): Promise<ToolResult> => {
			if (!client.hasApiKey) {
				return fail(NEEDS_KEY);
			}
			try {
				const s = summarizeJob(await client.getJob(jobId));
				return text(`${s.jobId}: ${s.status}.`, s);
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	return server;
}
