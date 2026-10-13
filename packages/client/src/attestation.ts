/**
 * The rights statement a person must confirm before a clean. Same wording as the
 * web's AttestationCheckbox; the server stores the version with the job.
 * Callers (CLI, MCP) must get a human's yes. It is never a default.
 */
export const ATTESTATION_VERSION = "v1";
export const ATTESTATION_TEXT =
	"This is my image or I have the right to edit it, and I have permission from anyone shown. I will follow the terms of the tool that made it, and I am responsible for any labelling the law or the place I publish requires. I am 18 or older, and I agree to the Terms (https://demarker.io/legal/terms).";
