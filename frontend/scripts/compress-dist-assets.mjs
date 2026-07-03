import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");
const compressible = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".webmanifest", ".xml"]);
let compressed = 0;
const files = [];

if (process.env.AUTO_AI_SKIP_COMPRESSION === "1") {
  console.log("Skipped production asset compression.");
  process.exit(0);
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (path.endsWith(".gz") || path.endsWith(".br")) continue;
    if (!compressible.has(extname(path))) continue;
    files.push(path);
  }
}

walk(distDir);

for (const path of files) {
  if (!existsSync(path)) continue;
  const input = readFileSync(path);
  if (input.length < 512) continue;
  writeFileSync(`${path}.gz`, gzipSync(input, { level: 9 }));
  writeFileSync(
    `${path}.br`,
    brotliCompressSync(input, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11
      }
    })
  );
  compressed += 1;
}

console.log(`Compressed ${compressed} production assets.`);
