import { ArrowLeft, PhoneCall, RefreshCw, Settings } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CallsTab } from "./CallsTab";

export function CallsPage() {
  const navigate = useNavigate();
  const [refreshRequestId, setRefreshRequestId] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <main className="calls-workspace-page">
      <header className="calls-workspace-header">
        <button type="button" onClick={() => navigate("/hub")} title="Back to Action Hub" aria-label="Back to Action Hub"><ArrowLeft size={18} /></button>
        <span><PhoneCall size={18} /><span><strong>Call Hub</strong><small>Private audio and video calls</small></span></span>
        <span className="calls-header-actions">
          <button type="button" onClick={() => setRefreshRequestId((value) => value + 1)} disabled={refreshing} title="Refresh calls" aria-label="Refresh calls"><RefreshCw className={refreshing ? "animate-spin" : ""} size={16} /><span>{refreshing ? "Refreshing" : "Refresh"}</span></button>
          <button type="button" onClick={() => navigate("/settings?section=calls")} title="Call settings" aria-label="Open call settings"><Settings size={18} /></button>
        </span>
      </header>
      <section className="calls-workspace-content">
        <CallsTab refreshRequestId={refreshRequestId} onRefreshingChange={setRefreshing} />
      </section>
    </main>
  );
}
