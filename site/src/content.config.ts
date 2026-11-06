import { defineCollection } from "astro:content";
import { docsCollection, withNimbusMarkdown } from "@cloudflare/nimbus-docs/content";
import { recallDocsLoader } from "./lib/docs-loader";

export const collections = {
  // The repo's docs/ files, served at /docs/ by src/pages/docs/[...slug].astro.
  recall: defineCollection({
    loader: withNimbusMarkdown(recallDocsLoader()),
    schema: docsCollection().schema,
  }),
};
