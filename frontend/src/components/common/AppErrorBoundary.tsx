import { Component, type ErrorInfo, type ReactNode } from "react";
import { enableSafeMode } from "../../reliability/safeMode";

type AppErrorBoundaryProps = {
  children: ReactNode;
  resetKey?: string;
};

type AppErrorBoundaryState = {
  error: Error | null;
  referenceId: string;
};

const CHUNK_RELOAD_KEY = "auto-ai-chunk-reload-attempted";
const CHUNK_RELOAD_ENTRY_KEY = "auto-ai-chunk-reload-entry";

function currentEntrySource(root: ParentNode = document) {
  return root.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? "";
}

async function deploymentVersionChanged() {
  if (!navigator.onLine) return false;
  const response = await fetch("/index.html", { cache: "no-store", headers: { "Cache-Control": "no-cache" } });
  if (!response.ok) return false;
  const documentCopy = new DOMParser().parseFromString(await response.text(), "text/html");
  const latestEntry = currentEntrySource(documentCopy);
  const activeEntry = currentEntrySource();
  return Boolean(latestEntry && activeEntry && latestEntry !== activeEntry);
}

function isChunkLoadError(error: Error) {
  const message = `${error.name} ${error.message}`.toLowerCase();
  return (
    message.includes("chunkloaderror") ||
    message.includes("failed to fetch dynamically imported module") ||
    message.includes("importing a module script failed") ||
    message.includes("loading chunk")
  );
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, referenceId: "" };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, referenceId: `ERR-${Date.now().toString(36).toUpperCase()}` };
  }

  componentDidMount() {
    try {
      const attemptedEntry = sessionStorage.getItem(CHUNK_RELOAD_ENTRY_KEY);
      if (attemptedEntry && attemptedEntry !== currentEntrySource()) {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        sessionStorage.removeItem(CHUNK_RELOAD_ENTRY_KEY);
      }
    } catch {
      return;
    }
  }

  componentDidUpdate(previousProps: AppErrorBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Auto-AI] App render failed.", { referenceId: this.state.referenceId, error, info });
    if (!isChunkLoadError(error)) return;
    void this.recoverFromDeploymentMismatch();
  }

  recoverFromDeploymentMismatch = async () => {
    try {
      if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === "1") return;
      if (!(await deploymentVersionChanged())) return;
      sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
      sessionStorage.setItem(CHUNK_RELOAD_ENTRY_KEY, currentEntrySource());
    } catch {
      return;
    }
    window.setTimeout(() => window.location.reload(), 100);
  };

  returnToHub = () => {
    window.location.assign("/hub");
  };

  restartInSafeMode = () => {
    enableSafeMode("render-error");
    window.location.assign("/hub");
  };

  render() {
    if (!this.state.error) return this.props.children;
    const chunkError = isChunkLoadError(this.state.error);
    return (
      <main className="app-error-page">
        <section className="app-error-card">
          <p className="settings-eyebrow">Auto-AI</p>
          <h1>{chunkError ? "Page failed to load" : "Something went wrong"}</h1>
          <p>
            {chunkError
              ? "The app could not load this page file. Retry or return to the main workspace."
              : "The page could not render. Retry or return to the main workspace."}
          </p>
          <p className="app-error-reference">Reference: {this.state.referenceId || "unavailable"}</p>
          <div className="app-error-actions">
            <button className="btn-primary" type="button" onClick={() => window.location.reload()}>
              Retry
            </button>
            <button className="btn-secondary" type="button" onClick={this.returnToHub}>
              Return to Action Hub
            </button>
            <button className="btn-secondary" type="button" onClick={this.restartInSafeMode}>
              Restart in Safe Mode
            </button>
            <a className="btn-secondary" href={`mailto:support@autoai.site.je?subject=Auto-AI%20problem%20${encodeURIComponent(this.state.referenceId)}`}>
              Report Problem
            </a>
          </div>
        </section>
      </main>
    );
  }
}
