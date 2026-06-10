import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertNoSemverFallback, assertVersionGuard, releaseVersionFromEnv } from "../src/lib/version-guard";

function writeGuardFixture(packageVersion: string, versionSource: string) {
	const dir = mkdtempSync(join(tmpdir(), "recall-version-guard-"));
	const packageJsonPath = join(dir, "package.json");
	const versionSourcePath = join(dir, "version.ts");

	writeFileSync(packageJsonPath, JSON.stringify({ version: packageVersion }, null, 2));
	writeFileSync(versionSourcePath, versionSource);

	return { packageJsonPath, versionSourcePath };
}

describe("releaseVersionFromEnv", () => {
	test("does not require a release version on ordinary PR or branch runs", () => {
		expect(releaseVersionFromEnv({ GITHUB_REF: "refs/heads/main", GITHUB_REF_TYPE: "branch" })).toBeUndefined();
	});

	test("normalizes tag versions with a leading v", () => {
		expect(releaseVersionFromEnv({ GITHUB_REF: "refs/tags/v1.2.3" })).toBe("1.2.3");
		expect(releaseVersionFromEnv({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" })).toBe("1.2.3");
	});
});

describe("assertVersionGuard", () => {
	test("passes for ordinary code runs without requiring a version bump", () => {
		const fixture = writeGuardFixture("1.2.3", 'let _version = "unknown"; // fallback');
		expect(assertVersionGuard({ ...fixture, env: { GITHUB_REF_TYPE: "branch" } })).toEqual({ packageVersion: "1.2.3" });
	});

	test("rejects invalid package versions", () => {
		const fixture = writeGuardFixture("1.2", 'let _version = "unknown"; // fallback');
		expect(() => assertVersionGuard({ ...fixture, env: {} })).toThrow("package.json.version must be strict semver");
	});

	test("requires tag and release versions to match package.json", () => {
		const fixture = writeGuardFixture("1.2.3", 'let _version = "unknown"; // fallback');
		expect(() => assertVersionGuard({ ...fixture, env: { GITHUB_REF: "refs/tags/v1.2.4" } })).toThrow(
			"release/tag version 1.2.4 does not match package.json.version 1.2.3",
		);
	});

	test("rejects semver fallback literals in src/version.ts", () => {
		expect(() => assertNoSemverFallback('let _version = "0.4.1"; // fallback')).toThrow(
			"src/version.ts fallback must not be a semver release source",
		);
	});
});
