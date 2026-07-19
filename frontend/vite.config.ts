import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function sourceSignature(paths: string[]) {
  const entries: string[] = [];
  const collect = (path: string) => {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      entries.push(`${path}:${stat.mtimeMs}:${stat.size}`);
      return;
    }
    readdirSync(path, { withFileTypes: true }).forEach((entry) => collect(`${path}/${entry.name}`));
  };
  paths.forEach(collect);
  return entries.join("|");
}

function reliableWindowsLiveReload(): Plugin {
  return {
    name: "auto-ai-reliable-windows-live-reload",
    apply: "serve",
    configureServer(server) {
      if (process.platform !== "win32") return;

      const watchedPaths = [
        fileURLToPath(new URL("./src", import.meta.url)),
        fileURLToPath(new URL("./public", import.meta.url)),
        fileURLToPath(new URL("./index.html", import.meta.url))
      ];
      let signature = sourceSignature(watchedPaths);
      let pollCount = 0;
      let changeCount = 0;
      let reloadCount = 0;
      let lastChangeAt: string | null = null;
      let reloadTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleReload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadCount += 1;
          server.moduleGraph.invalidateAll();
          server.ws.send({ type: "full-reload", path: "*" });
        }, 140);
      };

      const pollingTimer = setInterval(() => {
        pollCount += 1;
        try {
          const nextSignature = sourceSignature(watchedPaths);
          if (nextSignature === signature) return;
          signature = nextSignature;
          changeCount += 1;
          lastChangeAt = new Date().toISOString();
          scheduleReload();
        } catch (error) {
          server.config.logger.warn(`Live-reload polling failed: ${String(error)}`);
        }
      }, 500);
      pollingTimer.unref();

      server.middlewares.use("/__auto-ai-live-reload", (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          active: true,
          mode: "mtime-polling",
          intervalMs: 500,
          pollCount,
          changeCount,
          reloadCount,
          lastChangeAt,
          watchedPaths
        }));
      });

      server.httpServer?.once("close", () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        clearInterval(pollingTimer);
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), reliableWindowsLiveReload()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    hmr: {
      protocol: "ws",
      host: "127.0.0.1",
      port: 5173,
      clientPort: 5173,
      overlay: true
    },
    open: true,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0"
    },
    watch: {
      usePolling: true,
      interval: 250
    }
  }
});
