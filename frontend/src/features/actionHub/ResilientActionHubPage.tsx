import { Component, type ErrorInfo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { ActionHubPage } from "./ActionHubPage";

class HubBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Auto-AI] Action Hub render failed; switching to minimal workspace.", { error, info });
    try {
      localStorage.setItem("auto-ai-safe-mode", JSON.stringify({ enabled: true, reason: "hub-render-error", enabledAt: Date.now() }));
    } catch {
      // Continue with the in-memory recovery UI.
    }
  }

  render() {
    return this.state.failed ? <SafeHub /> : this.props.children;
  }
}

function SafeHub() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const name = typeof user?.name === "string" && user.name.trim() ? user.name.trim().split(/\s+/)[0] : "there";

  if (!user) {
    return (
      <main className="app-recovery-page">
        <section className="app-recovery-card">
          <p className="settings-eyebrow">Auto-AI</p>
          <h1>Welcome back</h1>
          <p>Your session needs to be restored before opening the workspace.</p>
          <button className="btn-primary app-recovery-primary" type="button" onClick={() => navigate("/login", { replace: true })}>Open Login</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-recovery-page">
      <section className="app-recovery-card">
        <p className="settings-eyebrow">Auto-AI</p>
        <h1>Hi, {name}</h1>
        <p>The full Action Hub hit a recoverable render problem. Your account and data are still safe. Use the lightweight workspace below while the affected feature is isolated.</p>
        <div className="app-recovery-grid">
          <button type="button" onClick={() => navigate("/chat")}>AI Chat</button>
          <button type="button" onClick={() => navigate("/seva")}>AutoAI Seva</button>
          <button type="button" onClick={() => navigate("/call-hub/search")}>Calls</button>
          <button type="button" onClick={() => navigate("/alarms")}>AI Alarm</button>
          <button type="button" onClick={() => navigate("/messages")}>Messages</button>
          <button type="button" onClick={() => navigate("/settings")}>Settings</button>
        </div>
        <div className="app-error-actions">
          <button className="btn-secondary" type="button" onClick={() => window.location.reload()}>Retry full Hub</button>
          <button className="btn-secondary" type="button" onClick={() => void logout()}>Logout</button>
        </div>
      </section>
    </main>
  );
}

export function ResilientActionHubPage() {
  return (
    <HubBoundary>
      <ActionHubPage />
    </HubBoundary>
  );
}
