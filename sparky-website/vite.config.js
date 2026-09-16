import { readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

import { defineConfig, loadEnv } from "vite";

const root = resolve(import.meta.dirname);
const rootPages = readdirSync(root)
  .filter((name) => name.endsWith(".html"))
  .map((name) => [basename(name, ".html"), resolve(root, name)]);
const docsRoot = resolve(root, "docs");
const docsPages = readdirSync(docsRoot)
  .filter((name) => name.endsWith(".html"))
  .map((name) => [`docs-${basename(name, ".html")}`, resolve(docsRoot, name)]);

const siteUrl = "https://sparky.llc";
const googleVerificationContent = "mYlfTvYpay5cARIQYu8KWcQfQELLQ0C-mAfcwX_nR9w";
const defaultDescription =
  "Sparky is a desktop coding agent for planning, editing, running, and reviewing real software work.";
const pageSeo = {
  "index.html": {
    title: "Sparky - The desktop coding agent",
    description:
      "Sparky is a focused desktop coding agent that plans, edits, runs, and reviews real work across your projects.",
  },
  "download.html": {
    title: "Download Sparky - Desktop coding agent",
    description:
      "Download Sparky for Windows, macOS, or Linux and keep your coding work local, visible, and reviewable.",
  },
  "changelog.html": {
    title: "Sparky Changelog - Product updates",
    description: "See the latest Sparky desktop coding agent releases, improvements, and fixes.",
  },
  "404.html": {
    title: "Page not found - Sparky",
    description: "The Sparky page you requested could not be found. Return to the product, docs, or download page.",
  },
  "licenses.html": {
    title: "Sparky Legal & licenses",
    description: "Sparky's third-party software licenses and notices.",
  },
  "docs.html": {
    title: "Sparky Docs - Desktop coding agent guide",
    description:
      "Learn how to use Sparky for project context, prompts, terminal work, web search, reviews, and more.",
  },
  "docs/index.html": {
    title: "Sparky Docs - Get started",
    description:
      "Open the Sparky documentation hub for setup, workflows, models, sessions, and troubleshooting.",
  },
  "docs/overview.html": {
    title: "Sparky Docs - Overview",
    description: "Understand Sparky's workspace, threads, tools, and desktop coding workflow.",
  },
  "docs/getting-started.html": {
    title: "Sparky Docs - Quickstart",
    description: "Set up Sparky and start your first desktop coding agent session.",
  },
  "docs/models.html": {
    title: "Sparky Docs - Supported models",
    description: "Review the AI model options available in Sparky and how to choose one for your work.",
  },
  "docs/sessions.html": {
    title: "Sparky Docs - Sessions and threads",
    description: "Keep project conversations organized with Sparky sessions and threads.",
  },
  "docs/stateless-chats.html": {
    title: "Sparky Docs - Stateless chats",
    description: "Use Sparky chats without sending a project workspace as context.",
  },
  "docs/memory.html": {
    title: "Sparky Docs - Memory",
    description: "Use Sparky Memory for user-approved preferences, conventions, and project decisions.",
  },
  "docs/prompts.html": {
    title: "Sparky Docs - Prompts",
    description: "Write clear, effective prompts for Sparky coding tasks and project workflows.",
  },
  "docs/read-edit.html": {
    title: "Sparky Docs - Read and edit files",
    description: "Use Sparky to inspect project files, make changes, and review the resulting diff.",
  },
  "docs/terminal.html": {
    title: "Sparky Docs - Terminal workflows",
    description: "Run commands and inspect terminal evidence safely with Sparky.",
  },
  "docs/git.html": {
    title: "Sparky Docs - Git workflows",
    description: "Use Sparky with branches, diffs, commits, and everyday Git workflows.",
  },
  "docs/pull-requests.html": {
    title: "Sparky Docs - Pull requests",
    description: "Review GitHub pull requests, diffs, metadata, and merge actions in Sparky.",
  },
  "docs/preview.html": {
    title: "Sparky Docs - Preview your work",
    description: "Preview websites and local apps while Sparky helps you build and verify them.",
  },
  "docs/web-search.html": {
    title: "Sparky Docs - Web search",
    description: "Use Sparky web search to research current information and verify sources.",
  },
  "docs/search.html": {
    title: "Sparky Docs - Search",
    description: "Search across your project and find the context you need in Sparky.",
  },
  "docs/troubleshooting.html": {
    title: "Sparky Docs - Troubleshooting",
    description: "Find fixes and practical guidance for common Sparky setup and workflow issues.",
  },
};

const seoPlugin = () => ({
  name: "sparky-seo",
  transformIndexHtml: {
    order: "pre",
    handler(html, ctx) {
      const relativePath = relative(root, ctx.filename).replaceAll("\\", "/");
      const seo = pageSeo[relativePath] || {
        title: "Sparky",
        description: defaultDescription,
      };
      const canonicalPath = relativePath === "index.html" ? "/" : `/${relativePath}`;
      const canonicalUrl = `${siteUrl}${canonicalPath}`;
      const noIndex = relativePath === "404.html";
      const tags = [
        { tag: "title", children: seo.title },
        {
          tag: "meta",
          attrs: {
            name: "description",
            content: seo.description,
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "robots",
            content: noIndex
              ? "noindex,nofollow"
              : "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1",
          },
        },
        { tag: "link", attrs: { rel: "canonical", href: canonicalUrl } },
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        { tag: "meta", attrs: { property: "og:site_name", content: "Sparky" } },
        { tag: "meta", attrs: { property: "og:title", content: seo.title } },
        { tag: "meta", attrs: { property: "og:description", content: seo.description } },
        { tag: "meta", attrs: { property: "og:url", content: canonicalUrl } },
        { tag: "meta", attrs: { property: "og:image", content: `${siteUrl}/hero-iridescent.png` } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Sparky desktop coding agent" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:title", content: seo.title } },
        { tag: "meta", attrs: { name: "twitter:description", content: seo.description } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${siteUrl}/hero-iridescent.png` } },
      ];

      if (relativePath === "index.html") {
        tags.push({
          tag: "meta",
          attrs: {
            name: "google-site-verification",
            content: googleVerificationContent,
          },
        });
        tags.push({
          tag: "script",
          attrs: { type: "application/ld+json" },
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Organization",
                "@id": `${siteUrl}/#organization`,
                name: "Sparky",
                url: `${siteUrl}/`,
                logo: `${siteUrl}/logo.svg`,
              },
              {
                "@type": "WebSite",
                "@id": `${siteUrl}/#website`,
                url: `${siteUrl}/`,
                name: "Sparky",
                description: seo.description,
                publisher: { "@id": `${siteUrl}/#organization` },
              },
              {
                "@type": "SoftwareApplication",
                "@id": `${siteUrl}/#software`,
                name: "Sparky",
                url: `${siteUrl}/`,
                description: seo.description,
                applicationCategory: "DeveloperApplication",
                operatingSystem: "Windows, macOS, Linux",
                publisher: { "@id": `${siteUrl}/#organization` },
              },
            ],
          }),
        });
      }

      tags.push({
        tag: "script",
        attrs: { type: "application/ld+json" },
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebPage",
          "@id": `${canonicalUrl}#webpage`,
          url: canonicalUrl,
          name: seo.title,
          description: seo.description,
          isPartOf: { "@id": `${siteUrl}/#website` },
        }),
      });

      const htmlWithoutConflictingSeo = html
        .replace(/<title>[\s\S]*?<\/title>/i, "")
        .replace(/<meta\s+name=["']description["'][^>]*>/i, "");

      return { html: htmlWithoutConflictingSeo, tags };
    },
  },
});

const stablePageAssets = () => ({
  name: "sparky-stable-page-assets",
  apply: "build",
  generateBundle() {
    for (const name of [
      "styles.css",
      "changelog.css",
      "script.js",
      "changelog.js",
      "logo.svg",
      "hero-iridescent.png",
    ]) {
      this.emitFile({ type: "asset", fileName: name, source: readFileSync(resolve(root, name)) });
    }
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "");
  return {
    plugins: [
      stablePageAssets(),
      seoPlugin(),
      {
        name: "sparky-analytics",
        transformIndexHtml: {
          order: "pre",
          handler() {
            return [
              {
                tag: "meta",
                attrs: {
                  name: "sparky-analytics-endpoint",
                  content:
                    env.VITE_SPARKY_ANALYTICS_ENDPOINT ||
                    "https://sensible-buffalo-67.eu-west-1.convex.site/analytics/event",
                },
                injectTo: "head",
              },
              {
                tag: "meta",
                attrs: {
                  name: "clerk-publishable-key",
                  content:
                    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
                    env.VITE_CLERK_PUBLISHABLE_KEY ||
                    "",
                },
                injectTo: "head",
              },
              {
                tag: "meta",
                attrs: {
                  name: "convex-client-url",
                  content:
                    env.VITE_CONVEX_CLIENT_URL ||
                    "https://sensible-buffalo-67.eu-west-1.convex.cloud",
                },
                injectTo: "head",
              },
              {
                tag: "script",
                attrs: { src: "/analytics.js", defer: true },
                injectTo: "head",
              },
            ];
          },
        },
      },
    ],
    build: {
      rollupOptions: {
        input: Object.fromEntries([...rootPages, ...docsPages]),
      },
    },
  };
});
