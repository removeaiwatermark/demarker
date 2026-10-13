/** An error envelope from the API: `{ error: { code, message, resolution, docs, ...extra } }`. */
export class DemarkerApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly resolution?: string;
	/** Extra fields the API sent with the error (requiredCredits, balance, purchaseUrl, ...). */
	readonly details: Record<string, unknown>;

	constructor(
		status: number,
		code: string,
		message: string,
		details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "DemarkerApiError";
		this.status = status;
		this.code = code;
		this.details = details;
		const resolution = details.resolution;
		if (typeof resolution === "string") {
			this.resolution = resolution;
		}
	}
}

/** The caller broke a rule the client enforces before any request is sent. */
export class DemarkerClientError extends Error {
	readonly code: string;
	readonly details: Record<string, unknown>;

	constructor(
		code:
			| "CREDIT_CAP_REQUIRED"
			| "OVER_CREDIT_CAP"
			| "NO_OFFER"
			| "TIMEOUT"
			| "JOB_FAILED"
			| "REFUSED"
			| "ATTESTATION_REQUIRED"
			| "UPLOAD_FAILED"
			| "NO_API_KEY",
		message: string,
		details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "DemarkerClientError";
		this.code = code;
		this.details = details;
	}
}
