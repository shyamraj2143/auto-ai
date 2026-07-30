import type { ReactNode } from "react";

export function CallHubEmptyState({ title, action }: { title: string; action?: ReactNode }) { return <div className="calls-empty"><span>{title}</span>{action}</div>; }
