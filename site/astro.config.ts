import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
import { groups, pageUrl, repoUrl } from "./src/docs";

/** Public origin. Override with SITE_URL (the Pages project sets it for production). */
const site = process.env.SITE_URL || "https://recall.edheltzel.codes";

const nimbusConfig = defineNimbusConfig({
  site,
  title: "Recall",
  description:
    "Recall captures each session, distills it into one local SQLite file, and injects your identity plus top-ranked records when the next session starts, on hosts that support it.",
  locale: "en",
  homeLabel: "Docs",
  github: repoUrl,
  socialImage: "/og.png",
  socialImageAlt: "Recall: Memory for Coding Agents. Capture, distill, recall at session start.",
  sidebar: {
    items: groups.map((group) => ({
      label: group.label,
      collapsed: false,
      items: group.pages.map((page) => ({ label: page.label, link: pageUrl(page) })),
    })),
  },
});

export default defineConfig({
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    nimbus(nimbusConfig, {
      validateMdx: false,
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
