import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  if (git("rev-parse", "--is-shallow-repository") === "true") {
    git("fetch", "--unshallow", "--quiet");
    console.log("unshallow: fetched full history, so pages get git dates (sitemap lastmod, Last updated)");
  }
} catch (error) {
  console.warn(`unshallow: kept the shallow clone, pages get no git dates (${String(error.message).split("\n")[0]})`);
}
