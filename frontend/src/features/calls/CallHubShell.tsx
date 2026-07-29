import type { ReactNode } from "react";

export function CallHubShell({ navigation, header, status, children, details }: { navigation: ReactNode; header: ReactNode; status?: ReactNode; children: ReactNode; details?: ReactNode }) {
  return <section className="pulse-connect-shell">{navigation}<div className="pulse-connect-main">{header}{status}<div className="pulse-connect-content">{children}</div></div>{details}</section>;
}
