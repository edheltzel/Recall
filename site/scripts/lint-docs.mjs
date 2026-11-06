import path from "node:path";
import { lint } from "markdownlint/promise";
import { docsDir, pages } from "../src/docs.ts";

const results = await lint({
  files: pages.map((page) => path.join(docsDir, page.file)),
  config: {
    default: false,
    "heading-increment": true,
    "no-reversed-links": true,
    "no-missing-space-atx": true,
    "no-multiple-space-atx": true,
    "no-missing-space-closed-atx": true,
    "no-multiple-space-closed-atx": true,
    "no-duplicate-heading": { siblings_only: true },
    "single-title": true,
    "first-line-heading": { allow_preamble: true },
    "no-empty-links": true,
    "link-fragments": true,
    "reference-links-images": true,
    "table-column-count": true,
  },
});

const findings = Object.entries(results).flatMap(([file, errors]) =>
  errors.map((error) =>
    `${file}:${error.lineNumber} ${error.ruleNames[0]} ${error.ruleDescription}${error.errorDetail ? `: ${error.errorDetail}` : ""}`,
  ),
);

console.log(`Linted ${Object.keys(results).length} published Markdown files: ${findings.length} issues`);
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
}
