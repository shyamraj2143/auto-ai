import type { ReactNode } from "react";

export function CallHubShell({ navigation, status, children, details }: { navigation: ReactNode; status?: ReactNode; children: ReactNode; details?: ReactNode }) {
  return <section className="calls-tab pulse-connect-shell"><div className="pulse-connect-main">{navigation}{status}<div className="pulse-connect-content">{children}</div></div>{details}</section>;
}
