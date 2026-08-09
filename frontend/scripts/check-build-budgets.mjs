import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const distPath = fileURLToPath(dist);
const limits = {
  entryJavaScript: 470 * 1024,
  globalCss: 400 * 1024,
  totalAssets: 21 * 1024 * 1024,
};

function filesUnder(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

const html = readFileSync(new URL("index.html", dist), "utf8");
const entryPath = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1];
const cssPath = html.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/)?.[1];
if (!entryPath || !cssPath) throw new Error("Unable to identify production entry assets.");

const resolveAsset = (value) => new URL(value.replace(/^\//, ""), dist);
const measurements = {
  entryJavaScript: statSync(resolveAsset(entryPath)).size,
  globalCss: statSync(resolveAsset(cssPath)).size,
  totalAssets: filesUnder(distPath)
    .filter((file) => ![".br", ".gz"].includes(extname(file)))
    .reduce((total, file) => total + statSync(file).size, 0),
};

const failures = Object.entries(measurements)
  .filter(([name, value]) => value > limits[name])
  .map(([name, value]) => `${name}: ${value} bytes exceeds ${limits[name]} bytes`);

console.log("Production build budgets", measurements);
if (failures.length) throw new Error(failures.join("\n"));
