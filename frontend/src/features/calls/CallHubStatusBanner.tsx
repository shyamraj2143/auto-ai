import { ChevronDown, ShieldCheck } from "lucide-react";

export function CallHubStatusBanner({ state, details }: { state: "ready" | "limited" | "unavailable"; details: string[] }) {
  if (state === "ready" && !details.length) return null;
  return <details className={`pulse-status-card ${state}`}><summary><ShieldCheck size={17} /><span><strong>{state === "limited" ? "Calling is limited" : state === "unavailable" ? "Calling is unavailable" : "Calling is ready"}</strong><small>{state === "limited" ? "Some call routes may use secure fallback." : state === "unavailable" ? "Secure calling is temporarily unavailable." : "Calling services are ready."}</small></span><ChevronDown size={16} /></summary>{details.length > 0 && <ul>{details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}</details>;
}
