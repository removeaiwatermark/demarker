import { basename, dirname, extname, join } from "node:path";

/** Pick the extension from the bytes: the API returns the result as stored, not by name. */
export function detectExt(bytes: Uint8Array): string {
	const b = bytes;
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return ".png";
	}
	if (b[0] === 0xff && b[1] === 0xd8) {
		return ".jpg";
	}
	if (
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57
	) {
		return ".webp";
	}
	return ".png";
}

/** `photo.png` -> `photo.clean.png` next to the input, or inside/at `out`. */
export function outputPathFor(
	input: string,
	ext: string,
	out?: string,
	outIsDir = false,
): string {
	const name = `${basename(input, extname(input))}.clean${ext}`;
	if (!out) {
		return join(dirname(input), name);
	}
	return outIsDir ? join(out, name) : out;
}
