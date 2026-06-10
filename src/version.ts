// Single source of truth for version — update package.json only
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let _version = "unknown"; // fallback, never an authoritative release version

try {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	// Works from both src/ (dev) and dist/ (built)
	for (const rel of ["../package.json", "../../package.json"]) {
		try {
			const pkg = JSON.parse(readFileSync(join(__dirname, rel), "utf-8"));
			if (pkg.version) {
				_version = pkg.version;
				break;
			}
		} catch {
			/* try next */
		}
	}
} catch {
	/* use fallback */
}

export const VERSION = _version;
// Full version — not truncated to major.minor. Patch releases (0.7.11,
// 0.7.21, 0.7.22) are meaningful signals; showing "Recall 0.7" in
// `recall --help` / `recall stats` hides which patch level is running and
// makes install issues harder to triage.
export const DISPLAY_NAME = `Recall ${_version}`;
