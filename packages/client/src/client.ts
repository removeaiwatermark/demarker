import { DemarkerApiError, DemarkerClientError } from "./errors.ts";
import type {
	Balance,
	Job,
	JobStatus,
	PendingIdentify,
	Pricing,
	ProcessOptions,
	ScanTicket,
	UploadTicket,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://demarker.io/api/v1";
const TERMINAL: JobStatus[] = ["COMPLETED", "FAILED", "REFUSED", "EXPIRED"];

export interface ClientOptions {
	/**
	 * `sk_live_...` key from /app/settings/api. Optional: without it only the
	 * keyless `scan` methods and `getPricing` work.
	 */
	apiKey?: string;
	/** Defaults to DEMARKER_API_URL, then https://demarker.io/api/v1. */
	baseUrl?: string;
	fetch?: typeof fetch;
	userAgent?: string;
}

export interface WaitOptions {
	intervalMs?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (job: Job) => void;
}

export interface CleanOptions extends WaitOptions {
	bytes: Uint8Array;
	filename: string;
	tier?: "GPU" | "QUICK";
	/**
	 * Mandatory ceiling. The API has no one-shot job, so the cap is checked
	 * against the identify response's offer before any credit is spent.
	 */
	maxCredits: number;
	rightsAttested: boolean;
	keepResolution?: boolean;
	vendorHint?: string;
	force?: boolean;
	marks?: string[];
	secondAttestation?: string;
	idempotencyKey?: string;
	onIdentified?: (job: Job) => void;
}

export interface CleanResult {
	job: Job;
	image: Uint8Array;
	creditsCharged: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			return reject(signal.reason);
		}
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

export class DemarkerClient {
	readonly baseUrl: string;
	private readonly apiKey: string | undefined;
	/** False for a keyless client: only `scan*` and `getPricing` work. */
	get hasApiKey(): boolean {
		return Boolean(this.apiKey);
	}
	private readonly doFetch: typeof fetch;
	private readonly userAgent: string;

	constructor(options: ClientOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = (
			options.baseUrl ??
			process.env.DEMARKER_API_URL ??
			DEFAULT_BASE_URL
		).replace(/\/+$/, "");
		this.doFetch = options.fetch ?? fetch;
		this.userAgent = options.userAgent ?? "@demarker/client";
	}

	// ----- HTTP methods: one per endpoint, no file I/O -----

	createUpload(filename: string): Promise<UploadTicket> {
		return this.request("POST", "/upload", { filename });
	}

	/** PUT the bytes to the presigned URL. Not an API call, so no bearer token. */
	async putUpload(
		ticket: Pick<UploadTicket, "uploadUrl" | "contentType">,
		bytes: Uint8Array,
	): Promise<void> {
		const res = await this.doFetch(ticket.uploadUrl, {
			method: "PUT",
			headers: { "Content-Type": ticket.contentType },
			body: bytes as BodyInit,
		});
		if (!res.ok) {
			throw new DemarkerClientError(
				"UPLOAD_FAILED",
				`Upload failed with HTTP ${res.status}.`,
				{ status: res.status },
			);
		}
	}

	/** Returns the settled job, or a pending stub when identify is still running (202). */
	identify(
		uploadKey: string,
		idempotencyKey?: string,
	): Promise<Job | PendingIdentify> {
		return this.request(
			"POST",
			"/identify",
			{ uploadKey },
			idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
		);
	}

	getJob(id: string): Promise<Job> {
		return this.request("GET", `/jobs/${encodeURIComponent(id)}`);
	}

	listJobs(
		params: { status?: string; limit?: number; offset?: number } = {},
	) {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined) {
				q.set(k, String(v));
			}
		}
		const qs = q.size ? `?${q}` : "";
		return this.request<{ jobs: Job[]; total: number }>(
			"GET",
			`/jobs${qs}`,
		);
	}

	deleteJob(id: string) {
		return this.request<{ deleted: boolean; creditsRefunded: number }>(
			"DELETE",
			`/jobs/${encodeURIComponent(id)}`,
		);
	}

	/**
	 * Debits the offer. `rightsAttested` must be an explicit true. A retry after a
	 * lost response gets 409 JOB_NOT_IDENTIFIED, so a debit is never doubled.
	 */
	processJob(id: string, options: ProcessOptions): Promise<Job> {
		if (options.rightsAttested !== true) {
			throw new DemarkerClientError(
				"ATTESTATION_REQUIRED",
				"rightsAttested must be explicitly true.",
			);
		}
		return this.request(
			"POST",
			`/jobs/${encodeURIComponent(id)}/process`,
			options,
		);
	}

	getBalance(): Promise<Balance> {
		return this.request("GET", "/balance");
	}

	getPricing(): Promise<Pricing> {
		return this.request("GET", "/pricing", undefined, undefined, false);
	}

	// ----- Keyless scan: identify only, no API key -----

	/** Upload an image for the free identify step. Returns the job id and a secret claim token. */
	async scan(bytes: Uint8Array, filename: string): Promise<ScanTicket> {
		const form = new FormData();
		form.set("file", new Blob([bytes as BlobPart]), filename);
		return this.request<ScanTicket>(
			"POST",
			"/scan",
			form,
			undefined,
			false,
		);
	}

	getScan(id: string, claimToken: string): Promise<Job> {
		return this.request(
			"GET",
			`/scan/${encodeURIComponent(id)}`,
			undefined,
			{ "X-Claim-Token": claimToken },
			false,
		);
	}

	/** Keyless scan and wait for the identify result. */
	async scanBytes(
		bytes: Uint8Array,
		filename: string,
		options: WaitOptions = {},
	): Promise<Job> {
		const ticket = await this.scan(bytes, filename);
		const interval = options.intervalMs ?? 1500;
		const deadline = Date.now() + (options.timeoutMs ?? 120_000);
		for (;;) {
			const job = await this.getScan(ticket.id, ticket.claimToken);
			options.onProgress?.(job);
			if (job.status !== "UPLOADED" && job.status !== "IDENTIFYING") {
				return job;
			}
			if (Date.now() >= deadline) {
				throw new DemarkerClientError(
					"TIMEOUT",
					`Scan ${ticket.id} did not finish in time (status ${job.status}).`,
					{ jobId: ticket.id, status: job.status },
				);
			}
			await sleep(interval, options.signal);
		}
	}

	// ----- Helpers that combine calls -----

	/** Poll until `until` returns true or the job is terminal. */
	async waitForJob(
		id: string,
		until: (job: Job) => boolean,
		options: WaitOptions = {},
	): Promise<Job> {
		const interval = options.intervalMs ?? 2000;
		const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
		for (;;) {
			const job = await this.getJob(id);
			options.onProgress?.(job);
			if (until(job) || TERMINAL.includes(job.status)) {
				return job;
			}
			if (Date.now() >= deadline) {
				throw new DemarkerClientError(
					"TIMEOUT",
					`Job ${id} did not finish in time (status ${job.status}).`,
					{ jobId: id, status: job.status },
				);
			}
			await sleep(interval, options.signal);
		}
	}

	/** Upload, PUT and identify (free). Polls if the API answers 202. */
	async identifyBytes(
		bytes: Uint8Array,
		filename: string,
		options: WaitOptions & { idempotencyKey?: string } = {},
	): Promise<Job> {
		const ticket = await this.createUpload(filename);
		await this.putUpload(ticket, bytes);
		const first = await this.identify(
			ticket.uploadKey,
			options.idempotencyKey,
		);
		if (isSettledIdentify(first)) {
			return first;
		}
		return this.waitForJob(first.id, isSettledIdentify, options);
	}

	/** Download a result URL (valid for one hour). */
	async download(url: string): Promise<Uint8Array> {
		const res = await this.doFetch(url);
		if (!res.ok) {
			throw new DemarkerClientError(
				"UPLOAD_FAILED",
				`Download failed with HTTP ${res.status}.`,
				{ status: res.status },
			);
		}
		return new Uint8Array(await res.arrayBuffer());
	}

	/**
	 * Identify, check the price against `maxCredits`, process, wait, download.
	 * Spends nothing unless the offer is at or under the cap.
	 */
	async clean(options: CleanOptions): Promise<CleanResult> {
		if (!(Number.isFinite(options.maxCredits) && options.maxCredits >= 0)) {
			throw new DemarkerClientError(
				"CREDIT_CAP_REQUIRED",
				"maxCredits is required (a number of credits, 0 or more).",
			);
		}
		if (options.rightsAttested !== true) {
			throw new DemarkerClientError(
				"ATTESTATION_REQUIRED",
				"rightsAttested must be explicitly true.",
			);
		}
		const tier = options.tier ?? "GPU";
		const keepResolution = options.keepResolution === true;

		const identified = await this.identifyBytes(
			options.bytes,
			options.filename,
			options,
		);
		options.onIdentified?.(identified);
		if (identified.status === "REFUSED") {
			throw new DemarkerClientError(
				"REFUSED",
				`Identify refused this image: ${identified.refusalReason ?? "unspecified"}.`,
				{
					jobId: identified.id,
					refusalReason: identified.refusalReason,
				},
			);
		}

		const offer = identified.offers?.find(
			(o) => o.tier === tier && o.keepResolution === keepResolution,
		);
		if (!offer) {
			throw new DemarkerClientError(
				"NO_OFFER",
				`No ${tier} offer${keepResolution ? " at original size" : ""} for this image.`,
				{ jobId: identified.id, offers: identified.offers },
			);
		}
		if (offer.credits > options.maxCredits) {
			throw new DemarkerClientError(
				"OVER_CREDIT_CAP",
				`This run costs ${offer.credits} credit(s); maxCredits is ${options.maxCredits}. Nothing was charged.`,
				{
					jobId: identified.id,
					requiredCredits: offer.credits,
					maxCredits: options.maxCredits,
				},
			);
		}

		let started: Job;
		try {
			started = await this.processJob(identified.id, {
				tier,
				keepResolution,
				rightsAttested: true,
				vendorHint: options.vendorHint,
				force: options.force,
				marks: options.marks,
				secondAttestation: options.secondAttestation,
			});
		} catch (err) {
			// The debit may have landed before the response was lost. A second
			// pick is refused with 409, so look at the job instead.
			if (
				!(
					err instanceof DemarkerApiError &&
					err.code === "JOB_NOT_IDENTIFIED"
				)
			) {
				throw err;
			}
			started = await this.getJob(identified.id);
			if (
				!["PENDING", "PROCESSING", "COMPLETED"].includes(started.status)
			) {
				throw err;
			}
		}

		const done =
			started.status === "COMPLETED"
				? started
				: await this.waitForJob(
						started.id,
						(j) => j.status === "COMPLETED",
						options,
					);
		if (done.status !== "COMPLETED" || !done.outputs.image) {
			throw new DemarkerClientError(
				"JOB_FAILED",
				done.errorMessage ??
					`Job ended as ${done.status}. Credits are refunded automatically on failure.`,
				{
					jobId: done.id,
					status: done.status,
					errorCode: done.errorCode,
				},
			);
		}
		const image = await this.download(done.outputs.image);
		return {
			job: done,
			image,
			creditsCharged: done.creditsCharged ?? offer.credits,
		};
	}

	// ----- internals -----

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
		auth = true,
	): Promise<T> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"User-Agent": this.userAgent,
			...extraHeaders,
		};
		if (auth) {
			if (!this.apiKey) {
				throw new DemarkerClientError(
					"NO_API_KEY",
					"This call needs an API key. Create one at https://demarker.io/app/settings/api",
				);
			}
			headers.Authorization = `Bearer ${this.apiKey}`;
		}
		const isForm =
			typeof FormData !== "undefined" && body instanceof FormData;
		if (body !== undefined && !isForm) {
			headers["Content-Type"] = "application/json";
		}
		const res = await this.doFetch(`${this.baseUrl}${path}`, {
			method,
			headers,
			body:
				body === undefined
					? undefined
					: isForm
						? (body as FormData)
						: JSON.stringify(body),
		});
		const text = await res.text();
		let data: unknown;
		try {
			data = text ? JSON.parse(text) : undefined;
		} catch {
			data = undefined;
		}
		if (!res.ok) {
			const env = (
				data as { error?: Record<string, unknown> } | undefined
			)?.error;
			const { code, message, ...rest } = env ?? {};
			throw new DemarkerApiError(
				res.status,
				typeof code === "string" ? code : `HTTP_${res.status}`,
				typeof message === "string"
					? message
					: `Request failed with HTTP ${res.status}.`,
				rest,
			);
		}
		return data as T;
	}
}

/** True once identify has produced a result (not UPLOADED / IDENTIFYING). */
export function isSettledIdentify(j: Job | PendingIdentify): j is Job {
	return j.status !== "UPLOADED" && j.status !== "IDENTIFYING";
}
