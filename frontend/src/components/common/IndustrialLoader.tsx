type IndustrialLoaderProps = {
  status?: string;
  error?: string;
  onRetry?: () => void;
  compact?: boolean;
};

const STARTUP_STEPS = [
  "Restoring session",
  "Connecting securely",
  "Loading workspace",
  "Ready"
] as const;

function startupStage(status: string) {
  const value = status.toLowerCase();
  if (value.includes("ready")) return 3;
  if (value.includes("preparing") || value.includes("loading workspace")) return 2;
  if (value.includes("connecting") || value.includes("verifying")) return 1;
  return 0;
}

function AutoAiLaunchMark() {
  return (
    <svg className="industrial-loader-mark" viewBox="0 0 128 116" aria-hidden="true">
      <defs>
        <linearGradient id="autoai-loader-a" x1="18" y1="94" x2="90" y2="15" gradientUnits="userSpaceOnUse">
          <stop stopColor="#39c2ff" />
          <stop offset="0.52" stopColor="#1c9cff" />
          <stop offset="1" stopColor="#116df0" />
        </linearGradient>
        <linearGradient id="autoai-loader-b" x1="59" y1="16" x2="110" y2="98" gradientUnits="userSpaceOnUse">
          <stop stopColor="#31b7ff" />
          <stop offset="1" stopColor="#1268ec" />
        </linearGradient>
      </defs>
      <path d="M19 94 54 20c3.9-8.2 15.3-8.2 19.2 0L109 94" fill="none" stroke="#061427" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" opacity=".72" />
      <path d="M19 94 54 20c3.9-8.2 15.3-8.2 19.2 0" fill="none" stroke="url(#autoai-loader-a)" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m68 23 41 71" fill="none" stroke="url(#autoai-loader-b)" strokeWidth="18" strokeLinecap="round" />
      <path d="M53 78c7.6-7.9 17.5-8.6 25.5-1.2 3.8 3.6 6.4 8.1 8 13.8-11.9 6.7-24.4 4.7-32-3.5-2.2-2.4-2.7-5.7-1.5-9.1Z" fill="url(#autoai-loader-b)" />
    </svg>
  );
}

export function IndustrialLoader({
  status = "Restoring session",
  error,
  onRetry,
  compact = false
}: IndustrialLoaderProps) {
  const stage = startupStage(status);
  const retry = onRetry ?? (() => window.location.reload());

  return (
    <section
      className={compact ? "industrial-loader compact" : "industrial-loader"}
      data-stage={stage}
      data-error={error ? "true" : "false"}
      role="status"
      aria-live="polite"
      aria-busy={!error}
    >
      <div className="industrial-loader-frame">
        <div className="industrial-loader-brand" aria-label="AutoAI">
          <AutoAiLaunchMark />
          <div className="industrial-loader-wordmark"><span>Auto</span><strong>AI</strong></div>
        </div>

        <div className="industrial-loader-copy">
          <h1><span className="industrial-loader-desktop-title">Starting AutoAI</span><span className="industrial-loader-mobile-title">Quick Start</span></h1>
          <p>{error ? "Startup interrupted" : "Preparing your workspace"}</p>
        </div>

        {error && <p className="industrial-loader-error" role="alert">{error}</p>}

        <div className="industrial-loader-progress-row">
          <div
            className="industrial-loader-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={STARTUP_STEPS.length}
            aria-valuenow={error ? undefined : stage + 1}
            aria-valuetext={error || status}
          ><span /></div>
          <button type="button" className="industrial-loader-retry" onClick={retry}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.6-2.6L20 11M4 13l2.3 4.6A7 7 0 0 0 18 15" /></svg>
            Retry
          </button>
        </div>

        <ol className="industrial-loader-steps" aria-label="Startup progress">
          {STARTUP_STEPS.map((label, index) => {
            const state = index < stage ? "complete" : index === stage && !error ? "active" : "pending";
            return <li className={`is-${state}`} key={label}><span aria-hidden="true">{state === "complete" ? "✓" : ""}</span><strong>{label}</strong></li>;
          })}
        </ol>

        <div className="industrial-loader-workspace" aria-hidden="true">
          <aside>{Array.from({ length: 5 }, (_, index) => <span key={index}><i /><b /></span>)}</aside>
          <div className="industrial-loader-skeleton-grid">
            <span className="is-card"><i /><b /><b /></span>
            <span className="is-card"><i /><b /><b /></span>
            <span className="is-card"><i /><b /><b /></span>
            <span className="is-card is-tall"><i /><b /><b /><b /></span>
            <span className="is-card is-wide"><i /><b /><b /><b /></span>
          </div>
        </div>
        <span className="industrial-loader-status">{error || status}</span>
      </div>
    </section>
  );
}
