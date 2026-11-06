import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Loader, LoaderContext } from "astro/loaders";
import { docsDir, pages, repoBranch, repoUrl, urlForFile } from "../docs";

/**
 * Loads the published files from the repo's docs/ folder as they are on disk.
 *
 * - The first `# ` heading becomes the page title and leaves the body, so the
 *   layout renders it once.
 * - Relative links keep working off GitHub: a link to a published page becomes
 *   its site URL, and a link to any other repo file becomes that file on GitHub.
 */
export function recallDocsLoader(): Loader {
  return {
    name: "recall-docs",
    async load(context: LoaderContext) {
      const root = fileURLToPath(context.config.root);
      const dir = path.resolve(root, docsDir);
      const repoRoot = path.dirname(dir);
      const gitOutput = (...args: string[]) => {
        try {
          return execFileSync("git", args, {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch {
          return undefined;
        }
      };

      const sync = async () => {
        const fullHistory = gitOutput("rev-parse", "--is-shallow-repository") === "false";
        context.store.clear();
        for (const page of pages) {
          const abs = path.join(dir, page.file);
          const source = await fs.readFile(abs, "utf8");
          const { title, body } = splitTitle(source, page.file);
          const linked = rewriteLinks(body, (target) => resolveLink(target, dir, repoRoot));
          const filePath = path.relative(root, abs);
          const lastUpdated = fullHistory
            ? gitOutput("log", "-1", "--format=%aI", "--", abs) || undefined
            : undefined;
          const data = await context.parseData({ id: page.id, data: { title, lastUpdated }, filePath });
          context.store.set({
            id: page.id,
            data,
            body: linked,
            filePath,
            digest: context.generateDigest(source),
            rendered: await context.renderMarkdown(linked, { fileURL: pathToFileURL(abs) }),
          });
        }
      };

      await sync();
      context.watcher?.add(dir);
      // Nimbus awaits this callback to commit the reload as one transaction.
      context.watcher?.on("change", (changed: string) => {
        if (pages.some((page) => path.join(dir, page.file) === changed)) return sync();
      });
    },
  };
}

/** The "Back to README" line a doc opens with on GitHub; the site has its own navigation. */
const BACK_TO_README = /^\s*(?:←\s*)?\[(?:←\s*)?Back to README\]\(\.\.\/README\.md\)\s*$/;

/**
 * The first level-one heading outside code fences, as plain text, and the body
 * without it or the GitHub back link above it.
 */
function splitTitle(source: string, file: string) {
  const lines = source.split("\n");
  const code = fencedLines(lines);
  for (const [i, line] of lines.entries()) {
    const heading = code[i] ? null : /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const title = heading[1].replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      const body = [...lines.slice(0, i), ...lines.slice(i + 1)].filter((l) => !BACK_TO_README.test(l));
      return { title, body: body.join("\n") };
    }
  }
  throw new Error(`docs/${file} has no level-one heading to use as its title`);
}

/** Scheme (`https:`, `mailto:`), site path, or fragment: left as written. */
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** The site URL or GitHub URL for a relative link written in docs/. */
function resolveLink(target: string, dir: string, repoRoot: string): string {
  if (NOT_RELATIVE.test(target)) return target;
  const [file, hash] = target.split("#", 2);
  const suffix = hash ? `#${hash}` : "";
  const abs = path.resolve(dir, file);
  if (path.dirname(abs) === dir) {
    const url = urlForFile(path.basename(abs));
    if (url) return url + suffix;
  }
  const repoPath = path.relative(repoRoot, abs).split(path.sep).join("/");
  if (repoPath.startsWith("..")) throw new Error(`docs link ${target} points outside the repository`);
  return `${repoUrl}/blob/${repoBranch}/${repoPath}${suffix}`;
}

/** Rewrites every inline Markdown link target outside code fences and code spans. */
export function rewriteLinks(body: string, resolve: (target: string) => string): string {
  const lines = body.split("\n");
  const code = fencedLines(lines);
  return lines
    .map((line, i) =>
      code[i]
        ? line
        : // Odd parts are code spans.
          line
            .split(/(`+[^`]*`+)/)
            .map((part, j) => (j % 2 ? part : part.replace(/\]\(([^)\s]+)/g, (_, t: string) => `](${resolve(t)}`)))
            .join(""),
    )
    .join("\n");
}

/**
 * Which lines belong to a fenced code block, fences included. Per CommonMark,
 * a fence closes only on the same character, at least as long, with nothing
 * after it but whitespace.
 */
export function fencedLines(lines: string[]): boolean[] {
  let open: string | null = null;
  return lines.map((line) => {
    if (open === null) {
      const start = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
      if (start) open = start;
      return start !== undefined;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
    if (close && close[0] === open[0] && close.length >= open.length) open = null;
    return true;
  });
}
