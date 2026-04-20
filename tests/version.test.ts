import { describe, test, expect } from "bun:test";
import { VERSION, DISPLAY_NAME } from "../src/version";

describe("VERSION", () => {
	test("matches semver pattern X.Y.Z", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("equals the current package.json version", () => {
		const pkg = require("../package.json");
		expect(VERSION).toBe(pkg.version);
	});
});

describe("DISPLAY_NAME", () => {
	test('starts with "Recall "', () => {
		expect(DISPLAY_NAME.startsWith("Recall ")).toBe(true);
	});

	test("contains the full version derived from VERSION", () => {
		// 0.7.22 regression: DISPLAY_NAME was truncating to major.minor
		// ("Recall 0.7"), which hid patch-level state in `mem --help`
		// and `mem stats`. Must be the full X.Y.Z now.
		expect(DISPLAY_NAME).toBe(`Recall ${VERSION}`);
		expect(DISPLAY_NAME).toContain(VERSION);
	});
});
