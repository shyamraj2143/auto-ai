import { ArrowLeft, PhoneCall, RefreshCw, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { CallsTab } from "./CallsTab";

export function CallsPage() {
  const navigate = useNavigate();
  const [refreshRequestId, setRefreshRequestId] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const { section } = useParams();
  const validSections = new Set(["search", "requests", "chats", "calls", "alerts"]);

  useEffect(() => {
    if (section === "calls") setRefreshRequestId((value) => value + 1);
  }, [section]);

  if (section && !validSections.has(section)) return <Navigate to="/call-hub/search" replace />;
  const goBack = () => {
    const sameOriginReferrer = document.referrer ? new URL(document.referrer).origin === window.location.origin : false;
    if (sameOriginReferrer && window.history.length > 1) navigate(-1);
    else navigate("/hub");
  };
  return (
    <main className="calls-workspace-page">
      <header className="calls-workspace-header">
        <button type="button" onClick={goBack} title="Back" aria-label="Back"><ArrowLeft size={18} /></button>
        <span><span className="calls-header-mark"><PhoneCall size={18} /></span><span><strong>Call Hub</strong><small>Private audio and video communication</small></span></span>
        <span className="calls-header-actions">
          <button type="button" onClick={() => setRefreshRequestId((value) => value + 1)} disabled={refreshing} title="Refresh calls" aria-label="Refresh calls"><RefreshCw className={refreshing ? "animate-spin" : ""} size={16} /><span>{refreshing ? "Refreshing" : "Refresh"}</span></button>
          <button type="button" onClick={() => navigate("/settings?section=calls")} title="Call settings" aria-label="Open call settings"><Settings size={18} /></button>
        </span>
      </header>
      <section className="calls-workspace-content">
        <CallsTab refreshRequestId={refreshRequestId} onRefreshingChange={setRefreshing} routeSection={section} />
      </section>
    </main>
  );
}
