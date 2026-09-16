import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const distRoot = join(import.meta.dirname, "dist");

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

test("the production site satisfies the public quality contract", () => {
  const pages = walk(distRoot).filter((file) => file.endsWith(".html"));
  assert.ok(pages.length > 10, "the production build should contain the public pages");

  const titles = new Set();
  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    const pageName = relative(distRoot, file);
    assert.ok(html.trim().length > 200, `${pageName} must have inspectable source`);
    assert.doesNotMatch(html, /vercel\.app/i, `${pageName} must not leak a Vercel URL`);
    assert.match(html, /<html\b[^>]*\blang=["'][^"']+["']/i, `${pageName} needs a language`);
    assert.match(html, /<title>\s*[^<]+\s*<\/title>/i, `${pageName} needs a title`);
    const title = html.match(/<title>\s*([^<]+?)\s*<\/title>/i)?.[1];
    assert.ok(title && !titles.has(title), `${pageName} must have a unique title`);
    titles.add(title);
    assert.match(html, /<meta\b[^>]*name=["']description["'][^>]*>/i, `${pageName} needs a description`);
    assert.match(html, /<link\b[^>]*rel=["']canonical["'][^>]*>/i, `${pageName} needs a canonical URL`);
    assert.match(html, /<meta\b[^>]*property=["']og:image["'][^>]*>/i, `${pageName} needs an Open Graph image`);
    assert.match(html, /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>/i, `${pageName} needs structured data`);
    assert.match(html, /<link\b[^>]*rel=["'][^"']*icon/i, `${pageName} needs a favicon`);
    assert.equal((html.match(/<h1\b/gi) || []).length, 1, `${pageName} must have exactly one H1`);
    for (const image of html.matchAll(/<img\b[^>]*>/gi)) {
      assert.match(image[0], /\balt\s*=\s*["'][^"']*["']/i, `${pageName} has an image without alt text`);
    }
  }

  assert.ok(statSync(join(distRoot, "404.html")).size > 200, "a real 404 page must ship");
  assert.match(readFileSync(join(distRoot, "sitemap.xml"), "utf8"), /<urlset\b[\s\S]*<\/urlset>/i);
  assert.ok(statSync(join(distRoot, "llms.txt")).size > 80, "llms.txt must ship with the site");
  const robots = readFileSync(join(distRoot, "robots.txt"), "utf8");
  for (const bot of ["GPTBot", "ClaudeBot", "Google-Extended", "PerplexityBot"]) {
    assert.match(robots, new RegExp(`User-agent: ${bot}[\\s\\S]*?Disallow: /`, "i"));
  }
  assert.ok(!walk(distRoot).some((file) => file.endsWith(".map")), "production output must not ship source maps");

  const siteScripts = walk(join(distRoot, "assets")).filter((file) => file.endsWith(".js"));
  assert.ok(siteScripts.every((file) => statSync(file).size < 250_000), "site bundles must stay below 250 KB each");

});
