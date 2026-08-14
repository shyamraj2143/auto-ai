import express from "express";

const app = express();
const port = Number(process.env.PORT || 3000);
const repo = process.env.GITHUB_REPO || "shyamraj2143/auto-ai";
const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

let cached = null;
let cachedAt = 0;
const cacheTtlMs = 60_000;

async function latestApk() {
  if (cached && Date.now() - cachedAt < cacheTtlMs) return cached;

  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "AutoAI-APK-Download-Service"
    }
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);

  const release = await response.json();
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => String(item?.name || "").toLowerCase().endsWith(".apk"))
    : null;

  if (!asset?.browser_download_url) throw new Error("No APK asset found in latest GitHub release");

  cached = {
    url: asset.browser_download_url,
    name: asset.name,
    version: release.tag_name || release.name || "latest",
    size: Number(asset.size || 0),
    publishedAt: release.published_at || release.created_at || null
  };
  cachedAt = Date.now();
  return cached;
}

app.get("/", async (_req, res) => {
  try {
    const apk = await latestApk();
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto-AI APK Download</title></head><body style="font-family:system-ui;max-width:620px;margin:60px auto;padding:20px"><h1>Auto-AI Android</h1><p>Latest release: <b>${apk.version}</b></p><p><a href="/apk" style="font-size:18px">Download latest APK</a></p><p style="color:#666">This download service securely proxies the official GitHub release.</p></body></html>`);
  } catch (error) {
    res.status(503).json({ status: "unavailable", message: "Latest APK is temporarily unavailable", detail: String(error.message || error) });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "auto-ai-apk-download" }));

app.get("/apk", async (_req, res) => {
  try {
    const apk = await latestApk();
    res.redirect(302, apk.url);
  } catch (error) {
    res.status(503).json({ status: "unavailable", message: "APK is temporarily unavailable" });
  }
});

app.get("/latest", async (_req, res) => {
  try {
    res.json(await latestApk());
  } catch (error) {
    res.status(503).json({ status: "unavailable", message: "Latest APK is temporarily unavailable" });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Auto-AI APK download service listening on ${port}`);
});
