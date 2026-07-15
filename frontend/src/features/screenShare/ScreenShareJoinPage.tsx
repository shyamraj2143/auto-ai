import { Monitor, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useScreenShare } from "./useScreenShare";

export function ScreenShareJoinPage() {
  const { sessionId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const share = useScreenShare();
  const invite = searchParams.get("invite");

  useEffect(() => {
    if (sessionId) void share.joinInviteLink(sessionId, invite);
  }, [invite, sessionId]);

  return (
    <main className="ss-join-page">
      <Monitor size={42} />
      <strong>{share.uiState === "failed" ? "Unable to join screen share" : "Joining screen share..."}</strong>
      <span>{share.error || (share.uiState === "reconnecting" ? "Reconnecting..." : "Keep this tab open.")}</span>
      {share.uiState === "failed" && (
        <button type="button" onClick={() => void share.joinInviteLink(sessionId, invite)}>
          <RefreshCw size={16} /> Retry
        </button>
      )}
    </main>
  );
}
