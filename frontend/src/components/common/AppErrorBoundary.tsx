import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
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
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidMount() {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Auto-AI] App render failed.", error, info);
    if (!isChunkLoadError(error)) return;
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === "1") return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
    window.setTimeout(() => window.location.reload(), 100);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunkError = isChunkLoadError(this.state.error);
    return (
      <main className="app-error-page">
        <section className="app-error-card">
          <p className="settings-eyebrow">Auto-AI</p>
          <h1>{chunkError ? "Updating workspace" : "Something went wrong"}</h1>
          <p>
            {chunkError
              ? "The app is loading the latest files. Refresh if it does not continue automatically."
              : "The page could not render. Refresh the app to recover."}
          </p>
          <button className="btn-primary" type="button" onClick={() => window.location.reload()}>
            Refresh app
          </button>
        </section>
      </main>
    );
  }
}
