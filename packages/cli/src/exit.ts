import { DemarkerApiError, DemarkerClientError } from "@demarker/client";

/** Exit codes are part of the CLI contract; scripts and agents branch on them. */
export const EXIT = {
	OK: 0,
	ERROR: 1,
	USAGE: 2,
	AUTH: 3,
	CREDITS: 4,
	REJECTED: 5,
	REGION: 6,
	JOB_FAILED: 7,
	NETWORK: 8,
} as const;

export class UsageError extends Error {}

export function exitCodeFor(err: unknown): number {
	if (err instanceof UsageError) {
		return EXIT.USAGE;
	}
	if (err instanceof DemarkerApiError) {
		if (err.status === 451) {
			return EXIT.REGION;
		}
		if (err.status === 401 || err.status === 403) {
			return EXIT.AUTH;
		}
		if (err.status === 402) {
			return EXIT.CREDITS;
		}
		if (err.status === 429 || err.status >= 500) {
			return EXIT.NETWORK;
		}
		if (
			err.status === 400 ||
			err.status === 404 ||
			err.status === 409 ||
			err.status === 422
		) {
			return EXIT.REJECTED;
		}
		return EXIT.ERROR;
	}
	if (err instanceof DemarkerClientError) {
		switch (err.code) {
			case "OVER_CREDIT_CAP":
				return EXIT.CREDITS;
			case "CREDIT_CAP_REQUIRED":
			case "ATTESTATION_REQUIRED":
				return EXIT.USAGE;
			case "REFUSED":
			case "NO_OFFER":
				return EXIT.REJECTED;
			case "JOB_FAILED":
			case "TIMEOUT":
				return EXIT.JOB_FAILED;
			default:
				return EXIT.NETWORK;
		}
	}
	if (err instanceof TypeError) {
		return EXIT.NETWORK; // fetch failed
	}
	return EXIT.ERROR;
}
