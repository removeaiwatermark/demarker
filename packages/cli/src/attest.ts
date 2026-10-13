import { createInterface } from "node:readline/promises";
import { ATTESTATION_TEXT, ATTESTATION_VERSION } from "@demarker/client";
import { UsageError } from "./exit.ts";

/**
 * `--attest-rights` is the only non-interactive way to attest. On a terminal we
 * ask; with --json or no TTY there is nobody to ask, so the flag is required.
 */
export async function confirmRights(
	flag: boolean,
	json: boolean,
): Promise<true> {
	if (flag) {
		return true;
	}
	if (json || !process.stdin.isTTY || !process.stderr.isTTY) {
		throw new UsageError(
			`Cleaning needs a rights attestation. Re-run with --attest-rights to confirm (${ATTESTATION_VERSION}):\n${ATTESTATION_TEXT}`,
		);
	}
	process.stderr.write(`\n${ATTESTATION_TEXT}\n\n`);
	const rl = createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	try {
		const answer = (await rl.question("Do you confirm this? [y/N] "))
			.trim()
			.toLowerCase();
		if (answer === "y" || answer === "yes") {
			return true;
		}
	} finally {
		rl.close();
	}
	throw new UsageError(
		"Not confirmed. Nothing was uploaded for cleaning and nothing was charged.",
	);
}
