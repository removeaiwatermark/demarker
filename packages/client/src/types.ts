/** Shapes of `/api/v1` responses. Mirror `apps/web/app/api/v1/lib/serialize.ts`. */

export type JobStatus =
	| "UPLOADED"
	| "IDENTIFYING"
	| "IDENTIFIED"
	| "HELD"
	| "PENDING"
	| "PROCESSING"
	| "COMPLETED"
	| "FAILED"
	| "REFUSED"
	| "EXPIRED";

export type Tier = "QUICK" | "GPU";

export interface Offer {
	tier: Tier;
	keepResolution: boolean;
	credits: number;
	[key: string]: unknown;
}

export interface Job {
	id: string;
	status: JobStatus;
	progress: number | null;
	width: number;
	height: number;
	megapixels: number;
	band: string | null;
	hasInvisibleTarget: boolean | null;
	vendor: string | null;
	/** The identify report: visible marks, AI metadata, inferred hidden watermarks. */
	report: unknown;
	cmiFields: unknown;
	offers: Offer[] | null;
	/** Present on the identify response only. */
	balance?: number;
	attestationVersion: string | null;
	tier: Tier | null;
	keepResolution: boolean | null;
	creditsCharged: number | null;
	refusalReason: string | null;
	processBlocked: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	cleanReport: unknown;
	outputs: { image: string | null };
	createdAt: string;
	completedAt: string | null;
	expiresAt: string | null;
}

/** 202 from /identify while the worker is still busy. */
export interface PendingIdentify {
	id: string;
	status: JobStatus;
}

export interface UploadTicket {
	uploadUrl: string;
	uploadKey: string;
	expiresAt: string;
	maxFileSizeBytes: number;
	maxFileSizeMb: number;
	contentType: string;
}

export interface Balance {
	balanceCredits: number;
	updatedAt: string;
}

export interface Pricing {
	unit: string;
	bandMegapixels: number;
	maxMegapixels: number;
	tiers: {
		QUICK: { purchasable: boolean; freePerDayWeb: number };
		GPU: { standardOutput: number; originalOverBand: number };
	};
	packs: { id: string; label: string; credits: number; priceCents: number }[];
}

export interface ProcessOptions {
	tier: Tier;
	/** Must be an explicit `true`. There is no default. */
	rightsAttested: boolean;
	keepResolution?: boolean;
	vendorHint?: string;
	force?: boolean;
	marks?: string[];
	secondAttestation?: string;
}

/** 202 from POST /scan. `claimToken` is a secret: send it as X-Claim-Token, never in a URL. */
export interface ScanTicket {
	id: string;
	claimToken: string;
	status: JobStatus;
	width: number;
	height: number;
	megapixels: number;
	identifyOnly: boolean;
}
