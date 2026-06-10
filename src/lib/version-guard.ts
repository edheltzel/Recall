import { readFileSync } from "fs";

export type VersionGuardEnv = Record<string, string | undefined>;

export type VersionGuardInput = {
	packageJsonPath: string;
	versionSourcePath: string;
	env?: VersionGuardEnv;
};

export type VersionGuardResult = {
	packageVersion: string;
	releaseVersion?: string;
};

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const VERSION_SOURCE_FALLBACK = /(?:let|const)\s+\w*(?:version|VERSION)\w*\s*=\s*["']([^"']+)["'][^\n]*(?:fallback|Fallback|FALLBACK)|(?:fallback|Fallback|FALLBACK)[^\n]*["']([^"']+)["']/g;

export function isStrictSemver(version: string): boolean {
	return STRICT_SEMVER.test(version);
}

export function normalizeReleaseVersion(version: string): string {
	return version.startsWith("v") ? version.slice(1) : version;
}

export function releaseVersionFromEnv(env: VersionGuardEnv): string | undefined {
	const explicitVersion = env.RELEASE_VERSION ?? env.TAG_NAME;
	if (explicitVersion) return normalizeReleaseVersion(explicitVersion);

	if (env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME) {
		return normalizeReleaseVersion(env.GITHUB_REF_NAME);
	}

	const tagPrefix = "refs/tags/";
	if (env.GITHUB_REF?.startsWith(tagPrefix)) {
		return normalizeReleaseVersion(env.GITHUB_REF.slice(tagPrefix.length));
	}

	return undefined;
}

export function assertVersionGuard(input: VersionGuardInput): VersionGuardResult {
	const packageJson = JSON.parse(readFileSync(input.packageJsonPath, "utf-8")) as { version?: unknown };
	const packageVersion = packageJson.version;

	if (typeof packageVersion !== "string" || !isStrictSemver(packageVersion)) {
		throw new Error(`package.json.version must be strict semver, got ${String(packageVersion)}`);
	}

	const versionSource = readFileSync(input.versionSourcePath, "utf-8");
	assertNoSemverFallback(versionSource);

	const releaseVersion = releaseVersionFromEnv(input.env ?? process.env);
	if (releaseVersion !== undefined) {
		if (!isStrictSemver(releaseVersion)) {
			throw new Error(`release/tag version must be strict semver, got ${releaseVersion}`);
		}

		if (releaseVersion !== packageVersion) {
			throw new Error(`release/tag version ${releaseVersion} does not match package.json.version ${packageVersion}`);
		}
	}

	return { packageVersion, releaseVersion };
}

export function assertNoSemverFallback(versionSource: string): void {
	for (const match of versionSource.matchAll(VERSION_SOURCE_FALLBACK)) {
		const fallback = match[1] ?? match[2];
		if (fallback && isStrictSemver(fallback)) {
			throw new Error(`src/version.ts fallback must not be a semver release source, got ${fallback}`);
		}
	}
}
