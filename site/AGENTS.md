# site — public website (landing + docs)

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `site/`.

## Purpose

The public site at https://recall.edheltzel.codes: the landing page at `/` and the docs at `/docs/`, one static [Nimbus](https://nimbus-docs.com) (Astro) build. Migrated from `edheltzel/recall-site`.

## Ownership

- `src/pages/index.astro`, `src/layouts/Landing.astro`, `src/components/landing/`, `src/styles/landing/`, `src/scripts/`, `src/site.ts`, `public/loop/`, `public/og.png` — the landing page, its design and artwork. `scripts/og.py` regenerates `public/og.png`.
- `src/docs.ts` — the only list of published docs: file, URL, sidebar group and label.
- `src/lib/docs-loader.ts` — reads those files from `../docs` at build time (title from the first `#` heading, GitHub-relative links rewritten to site or GitHub URLs).
- `src/pages/docs/[...slug].astro` — the docs route; the rest of `src/` (layouts, `components/ui/`, `pages/`, `styles/globals.css`) is the Nimbus starter, branded.
- `public/_redirects` — Cloudflare Pages redirects for URLs from the earlier site.
- `scripts/check-dist.mjs` and `scripts/{contrast,flash,install-box}.mjs` — post-build checks.

## Local Contracts

- Tooling is isolated from Recall's runtime: npm with `site/package-lock.json`, Node `>=22.12` (`.node-version` pins the Pages build), exact dependency pins. Never add site dependencies, scripts, or tests to the root `package.json`, `bun.lock`, `tsconfig*.json`, or CI; never import `src/` or `hooks/` from the site.
- Docs content lives only in `../docs/*.md`. Never copy a doc into `site/`. Publish a doc by adding it to `src/docs.ts`; never publish `docs/AGENTS.md`, `docs/agents/`, `docs/adr/`, `docs/benchmarks/`, `docs/hosts/FOR_*.md`, `docs/releasing.md`, or `.agents/`.
- Docs stay GitHub-friendly: no frontmatter, relative links, one `#` title. The loader adapts them; never add site-only syntax to `docs/`.
- A page's URL is its `id` in `src/docs.ts`. Renaming one needs a `public/_redirects` entry.
- Theme choice is shared across landing and docs through `localStorage["recall-theme"]`.

## Work Guidance

- Upgrade Nimbus with `npx nimbus-docs migrate --dry-run --diff`, then `migrate --yes`; take starter fixes with `npx nimbus-docs outdated` and `diff <file>`. Keep `nimbus.json` committed and never edit it by hand.
- After approved cutover, Cloudflare Pages builds this folder: root directory `site`, build command `npm run build`, output `dist`.

## Verification

From `site/`: `npm ci`, `npm run typecheck`, `npm run build`, `npm run check:dist`, `npm run check:nimbus`, and `CHROME_PATH=<chrome> npm run check:landing`.

## Child DOX Index

No child docs.
