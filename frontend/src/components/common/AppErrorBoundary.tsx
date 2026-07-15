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
      sessionStorage.removeItem(CHUNK_RELOAD_KEY);
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
    try {
      if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === "1") return;
      sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
    } catch {
      return;
    }
    window.setTimeout(() => window.location.reload(), 100);
  }

  returnToChat = () => {
    window.location.hash = "#/chat";
  };

  restartInSafeMode = () => {
    enableSafeMode("render-error");
    window.location.hash = "#/chat";
    window.location.reload();
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
            <button className="btn-primary" type="button" onClick={() => this.setState({ error: null })}>
              Retry
            </button>
            <button className="btn-secondary" type="button" onClick={this.returnToChat}>
              Return to chat
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
