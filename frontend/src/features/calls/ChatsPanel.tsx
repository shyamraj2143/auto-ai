import type { ReactNode } from "react";
export function ChatsPanel({ children }: { children: ReactNode }) { return <section className="calls-list social-panel" aria-label="Accepted conversations">{children}</section>; }
