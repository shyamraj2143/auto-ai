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

// The public Railway URL is also the APK URL used by the Android updater.
// Redirect the root directly to the latest signed APK so existing clients
// following the configured base URL receive an actual APK, never HTML.
app.get("/", async (_req, res) => {
  try {
    const apk = await latestApk();
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, apk.url);
  } catch (_error) {
    res.status(503).json({ status: "unavailable", message: "Latest APK is temporarily unavailable" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "auto-ai-apk-download" }));

app.get("/apk", async (_req, res) => {
  try {
    const apk = await latestApk();
    res.redirect(302, apk.url);
  } catch (_error) {
    res.status(503).json({ status: "unavailable", message: "APK is temporarily unavailable" });
  }
});

app.get("/latest", async (_req, res) => {
  try {
    res.json(await latestApk());
  } catch (_error) {
    res.status(503).json({ status: "unavailable", message: "Latest APK is temporarily unavailable" });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Auto-AI APK download service listening on ${port}`);
});
