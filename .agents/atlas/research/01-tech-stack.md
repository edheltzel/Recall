# Tech Stack Comparison — openhuman vs atlas-recall

Sources of truth: `Cargo.toml`, `rust-toolchain.toml`, root `package.json`, `app/package.json`, `app/src-tauri/`, `Dockerfile`, `pnpm-workspace.yaml` for **openhuman** (github.com/tinyhumansai/openhuman, default branch `main`); `package.json`, `bun.lock`, `tsconfig.json`, `src/`, `hooks/` for **atlas-recall** (`/Users/ed/Developer/atlas-recall`).

## Side-by-Side

| Dimension | openhuman (tinyhumansai/openhuman) | atlas-recall (edheltzel/Recall) |
|-----------|-------------------------------------|--------------------------------|
| **Project shape** | Desktop AI super-app (multi-binary core + Tauri shell) | Single-purpose CLI + MCP server for persistent agent memory |
| **Version** | `0.53.47` | `0.8.0` |
| **License** | Custom (`LICENSE` 34 KB — non-standard, repo-defined) | MIT |
| **Primary language** | Rust (~14.7 MB) + TypeScript (~5.6 MB) + Shell (~390 KB) | TypeScript only |
| **Rust edition / toolchain** | Edition 2021, pinned `rustc 1.93.0` via `rust-toolchain.toml` (rustfmt + clippy, minimal profile) | n/a |
| **Runtime (binary side)** | `tokio` async runtime, full features | n/a |
| **Runtime (JS side)** | Node `>=24.0.0` (app workspace); root devDeps under pnpm | **Bun** (shebang rewritten from `#!/usr/bin/env node` → `#!/usr/bin/env bun` post-build); `engines.node >=18` declared but Bun is the actual runtime |
| **Package manager** | `pnpm@10.10.0` (workspace: `app` only) | Bun (`bun.lock` v1) |
| **Module system** | Rust crates + ESM (`"type": "module"`) | ESM (`"type": "module"`) |
| **Build tool — code** | `cargo build --release` (Rust core) + `tsc && vite build` (frontend) | `tsup` (ESM, `--external bun:sqlite`, post-build shebang rewrite) |
| **Build tool — desktop** | `cargo tauri build` (bundles app/dmg via `@tauri-apps/cli` 2.10) | none |
| **HTTP / RPC server** | `axum` 0.8 + `tower` 0.5 + `socketioxide` 0.15 (WS) + `tokio-tungstenite` | `@modelcontextprotocol/sdk` (stdio MCP transport) — no HTTP server |
| **Desktop wrapper** | **Tauri 2.10** with CEF + Wry, plugins: `deep-link`, `opener`, `os` | none |
| **UI / frontend framework** | **React 19.1**, React Router 7, Redux Toolkit 2.11, redux-persist, Radix UI dialog, cmdk, react-markdown, react-joyride | **none** (CLI + MCP only) |
| **Styling** | Tailwind CSS 3.4 + `@tailwindcss/forms` + `@tailwindcss/typography` + PostCSS + autoprefixer | n/a |
| **3D / motion / media** | three.js 0.183, lottie-react, Remotion 4.0.454 + `@remotion/player` (video pipeline) | none |
| **State management** | Redux Toolkit + react-redux + redux-logger + redux-persist | none |
| **Persistence (embedded)** | `rusqlite` 0.37 (`bundled`) — embedded SQLite | **`bun:sqlite`** + **FTS5** full-text search w/ sync triggers, WAL mode (DB at `~/.claude/memory.db`) |
| **Persistence (server)** | `postgres` 0.19 driver (with-chrono) — Postgres client built in | none |
| **Auth / crypto** | `aes-gcm`, `argon2`, `chacha20poly1305`, `ring`, `hmac`, `sha2`, `rustls` 0.23 + `tokio-rustls` + `webpki-roots`; client side: `@noble/{curves,hashes,secp256k1}`, `@scure/{base,bip32,bip39}` | none beyond standard `node:crypto` usage |
| **Validation / schema** | `serde` 1 + `serde_json` + `serde_yaml` + `schemars`; client-side `zod` 4.3 | `zod` 3.24 |
| **Logging / observability** | `tracing` + `tracing-subscriber` + `tracing-appender` + `prometheus` 0.14 + `opentelemetry` 0.31 (trace + metrics, OTLP exporter) + **Sentry** Rust 0.47 & `@sentry/react` 10 | none (intentional — extraction logs to stderr only) |
| **CLI parsing (Rust)** | `clap` 4.5 (derive) + `clap_complete` + `dialoguer` (interactive) + `indicatif` family via `console` | n/a |
| **CLI parsing (JS)** | n/a beyond Tauri bridge | `commander` 12 |
| **Audio / capture / input** | `cpal` 0.15 (audio), `whisper-rs` 0.16 (Whisper STT), `hound` (WAV), `enigo` 0.3 (synthetic input), `rdev` 0.5 (input events), `arboard` 3 (clipboard) | none |
| **Email / messaging** | `lettre` 0.11 (SMTP), `mail-parser`, `async-imap` 0.11, optional `matrix-sdk` 0.16, optional `whatsapp-rust` 0.5 | none |
| **Browser automation (opt)** | `fantoccini` 0.22 (WebDriver, rustls) | none |
| **Scheduling** | `cron` 0.12, `starship-battery` (laptop-throttle gate) | external (Claude Code `Stop` hook + cron-driven `BatchExtract.ts` + `TelosSync.ts`) |
| **Test framework** | `vitest` 4 + `@testing-library/{react,jest-dom,user-event}` + `jsdom`; Rust: `cargo test`; E2E: WebdriverIO 9 (`@wdio/cli`, `@wdio/local-runner`, `@wdio/mocha-framework`, `@wdio/appium-service`) | `bun:test` (vitest 2 declared but not the actual runner) |
| **Lint / format** | ESLint 9 + `@typescript-eslint` 8 + `eslint-plugin-{react,react-hooks,import}` + Prettier 3 + `@trivago/prettier-plugin-sort-imports` + `knip` 6 (dead-code) + clippy + rustfmt | `tsc --noEmit` (no ESLint configured) |
| **Git hooks** | Husky 9 | none (consumer is Claude Code itself) |
| **Bundling polyfills** | `vite-plugin-node-polyfills`, `buffer`, `process`, `util`, `os-browserify` (for browser-side Node-API usage) | none |
| **External integrations** | Slack (`slack-backfill` bin), Gmail (`gmail-backfill-3d` bin), Matrix, WhatsApp, IMAP, Composio | MCP clients (Claude Code primary); `mem` CLI consumed by `~/.claude/hooks/` |
| **TypeScript config** | `target` per app/tsconfig (TS ~5.8); strict + react JSX | `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`, declarations on |
| **Docker** | Multi-stage `rust:1.93-bookworm` builder → `debian:bookworm-slim` runtime; installs ALSA/X11/libxdo/libevdev/clang/mold for `cpal`/`enigo`/`arboard`/`rdev` | none |
| **Distribution channels** | `.deb` (Debian repo), Homebrew (formula in `homebrew-core` + `homebrew`), npm, macOS `.app`/`.dmg` (signed), Windows install (PowerShell) | `install.sh` from GitHub repo (clones + builds via Bun) |
| **Repo size signal** | Cargo.lock 222 KB, pnpm-lock.yaml 386 KB | bun.lock present; package.json: 3 prod deps + 4 devDeps |
| **Direct dep count (root manifest)** | ~80 crates in root `Cargo.toml` + ~40 prod deps + ~35 devDeps in `app/package.json` | **3 prod deps, 4 devDeps** |
| **Binaries produced** | `openhuman-core` (RPC server), `slack-backfill`, `gmail-backfill-3d`, plus Tauri app binary | `mem` (CLI), `mem-mcp` (MCP server) |
| **Hook / event surface** | None for end-user (it IS the app) | Claude Code hooks: `SessionExtract` (Stop), `SessionRecall` (SessionStart), `SessionPreCompact` (PreCompact), `BatchExtract` (cron), `TelosSync` (cron) |
| **Architecture posture** | Heavyweight monolith desktop platform — many concerns in one tree | Unix-philosophy small tool: one DB, one CLI, one MCP server, hooks for I/O |

## Synthesis

These projects sit at opposite ends of the AI-tooling spectrum. **openhuman** is a Tauri 2 desktop super-app: a Rust core (~80 crates) runs an axum + socket.io RPC server with embedded SQLite and a Postgres client, wraps Whisper-rs voice, system-input/clipboard control, multi-protocol messaging (IMAP, Matrix, WhatsApp), full observability (OpenTelemetry + Prometheus + Sentry), and a React 19 + Redux Toolkit + Tailwind + Three.js + Remotion frontend bundled via Vite. It ships through deb, Homebrew, npm, and signed macOS DMG. **atlas-recall** is the inverse: a single-purpose persistent-memory layer for Claude Code — pure TypeScript on Bun, three production deps (MCP SDK, commander, zod), `bun:sqlite` with FTS5 for storage, no UI, no server, no auth, no telemetry. It exposes one CLI (`mem`), one MCP server (`mem-mcp`), and a handful of `~/.claude/hooks/*.ts` scripts. Where openhuman builds *everything an AI agent might need to act on the OS*, atlas-recall builds *one durable thing the agent forgets without* — and pushes every other concern out to its consumer (Claude Code).

*Out of scope here (deferred to later artifacts in this series): CI/CD pipelines, code-signing identities, release/update channels, database migration tooling, and runtime config (`tauri.conf.json`, `.env.example`). This artifact is bounded to root-manifest evidence by design.*
