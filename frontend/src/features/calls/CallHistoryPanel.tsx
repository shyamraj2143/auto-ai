import type { ReactNode } from "react";
export function CallHistoryPanel({ children }: { children: ReactNode }) { return <section className="calls-list call-timeline" aria-label="Call history">{children}</section>; }
