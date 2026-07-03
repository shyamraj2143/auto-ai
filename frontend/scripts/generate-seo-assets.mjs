import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seoData = JSON.parse(readFileSync(resolve(root, "src/seo/seo-data.json"), "utf8"));
const siteUrl = seoData.siteUrl.replace(/\/$/, "");
const publicDir = resolve(root, "public");
const today = new Date().toISOString().slice(0, 10);

function absoluteUrl(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${siteUrl}${normalized}`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const sitemapUrls = seoData.routes
  .filter((route) => route.public && route.sitemap)
  .map((route) => `  <url>
    <loc>${xmlEscape(absoluteUrl(route.path))}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${xmlEscape(route.changefreq ?? "weekly")}</changefreq>
    <priority>${route.priority ?? 0.5}</priority>
  </url>`)
  .join("\n");

mkdirSync(publicDir, { recursive: true });

writeFileSync(
  resolve(publicDir, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls}
</urlset>
`,
  "utf8"
);

writeFileSync(
  resolve(publicDir, "robots.txt"),
  `User-agent: *
Allow: /
Sitemap: ${siteUrl}/sitemap.xml
`,
  "utf8"
);

writeFileSync(
  resolve(publicDir, "site.webmanifest"),
  JSON.stringify(
    {
      name: seoData.siteName,
      short_name: "Auto-AI",
      description: seoData.description,
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: seoData.themeColor,
      theme_color: seoData.themeColor,
      orientation: "portrait-primary",
      categories: ["productivity", "utilities"],
      icons: [
        { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/maskable-icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: "/icons/maskable-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
      ]
    },
    null,
    2
  ) + "\n",
  "utf8"
);

console.log(`Generated SEO assets for ${seoData.routes.filter((route) => route.public && route.sitemap).length} public routes.`);
