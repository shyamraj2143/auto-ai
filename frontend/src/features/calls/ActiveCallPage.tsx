import { useParams } from "react-router-dom";
import { useCallSession } from "./hooks/useCallSession";

export function ActiveCallPage() {
  const { callId } = useParams();
  const { call, sessionState } = useCallSession();
  const exactCallLoaded = Boolean(callId && call?.id === callId);
  return (
    <main className="active-call-route" aria-live="polite" data-call-id={callId ?? ""}>
      <span>{exactCallLoaded ? (sessionState === "reconnecting" ? "Reconnecting call service\u2026" : "Connecting\u2026") : "Restoring accepted call\u2026"}</span>
    </main>
  );
}
