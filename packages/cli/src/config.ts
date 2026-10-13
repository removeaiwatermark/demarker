import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function configPath(env = process.env): string {
	const dir = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(dir, "demarker", "config.json");
}

export async function readConfig(env = process.env): Promise<StoredConfig> {
	try {
		return JSON.parse(
			await readFile(configPath(env), "utf8"),
		) as StoredConfig;
	} catch {
		return {};
	}
}

export async function writeConfig(
	cfg: StoredConfig,
	env = process.env,
): Promise<string> {
	const file = configPath(env);
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
	await chmod(file, 0o600);
	return file;
}

export async function clearConfig(env = process.env): Promise<void> {
	await rm(configPath(env), { force: true });
}

/** Key from the environment first, then the config file. Never from argv. */
export async function resolveCredentials(env = process.env) {
	const stored = await readConfig(env);
	return {
		apiKey: env.DEMARKER_API_KEY || stored.apiKey,
		baseUrl: env.DEMARKER_API_URL || stored.baseUrl,
	};
}
