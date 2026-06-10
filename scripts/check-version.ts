#!/usr/bin/env bun
import { join } from "path";
import { assertVersionGuard } from "../src/lib/version-guard";

const root = process.cwd();
const result = assertVersionGuard({
	packageJsonPath: join(root, "package.json"),
	versionSourcePath: join(root, "src/version.ts"),
	env: process.env,
});

const releaseSuffix = result.releaseVersion ? ` for release/tag ${result.releaseVersion}` : "";
console.log(`Version guard passed: package.json.version ${result.packageVersion}${releaseSuffix}`);
