/**
 * The public docs: which files under the repo's docs/ folder the site publishes,
 * the URL each one gets under /docs/, and its place in the sidebar.
 *
 * The Markdown files stay the single source; the site reads them at build time.
 * Anything not listed here (plans, ADRs, agent guides, benchmarks, release
 * runbooks) is never published.
 */
export const repoUrl = "https://github.com/edheltzel/Recall";
/** Branch the site links to for files it doesn't publish. */
export const repoBranch = "main";
/** The repo's docs folder, relative to the site root (site/). */
export const docsDir = "../docs";
/** Where the collection is served; matches src/pages/docs/[...slug].astro. */
export const docsBase = "/docs";

interface Page {
  /** File name inside docs/. */
  file: string;
  /** Entry id; the page is served at /docs/<id>/ ("index" is /docs/). */
  id: string;
  /** Sidebar label. */
  label: string;
}

export const groups: { label: string; pages: Page[] }[] = [
  {
    label: "Start here",
    pages: [
      { file: "getting-started.md", id: "index", label: "Getting started" },
      { file: "installation.md", id: "installation", label: "Installation" },
      { file: "lifecycle.md", id: "lifecycle", label: "Managing Recall" },
      { file: "upgrading.md", id: "upgrading", label: "Upgrading" },
      { file: "troubleshooting.md", id: "troubleshooting", label: "Troubleshooting" },
      { file: "score-a-memory-with-jev.md", id: "score-with-jev", label: "Score a memory with Jev" },
    ],
  },
  {
    label: "Reference",
    pages: [
      { file: "cli-reference.md", id: "reference/cli", label: "CLI" },
      { file: "mcp-tools.md", id: "reference/mcp-tools", label: "MCP tools" },
      { file: "agent-skills.md", id: "reference/agent-skills", label: "Agent skills" },
      { file: "CAPTURE_ADAPTER.md", id: "reference/capture-adapter", label: "Capture adapter" },
      { file: "api.md", id: "reference/api", label: "Harness API" },
    ],
  },
  {
    label: "Integrations",
    pages: [
      { file: "CLAUDE_INTEGRATION.md", id: "integrations/claude-code", label: "Claude Code" },
      { file: "CODEX_INTEGRATION.md", id: "integrations/codex", label: "Codex" },
      { file: "PI_INTEGRATION.md", id: "integrations/pi", label: "Pi" },
      { file: "OPENCODE_INTEGRATION.md", id: "integrations/opencode", label: "OpenCode" },
      { file: "OMP_INTEGRATION.md", id: "integrations/omp", label: "omp" },
      { file: "GROK_INTEGRATION.md", id: "integrations/grok", label: "Grok" },
      { file: "EMPRYO_INTEGRATION.md", id: "integrations/empryo", label: "Empryo" },
      { file: "JCODE_INTEGRATION.md", id: "integrations/jcode", label: "JCode" },
    ],
  },
  {
    label: "Concepts",
    pages: [{ file: "architecture.md", id: "architecture", label: "Architecture" }],
  },
];

export const pages = groups.flatMap((group) => group.pages);

/** The URL a page is served at. */
export const pageUrl = (page: Page) => (page.id === "index" ? `${docsBase}/` : `${docsBase}/${page.id}/`);

/** The site URL for a published file, by its name inside docs/. */
export const urlForFile = (file: string) => {
  const page = pages.find((p) => p.file === file);
  return page ? pageUrl(page) : undefined;
};
