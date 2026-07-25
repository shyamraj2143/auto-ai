import { Home, TimerReset, UserRound } from "lucide-react";
import { NavLink } from "react-router-dom";

export function HubBottomNav() {
  return (
    <nav className="hub-bottom-nav" aria-label="Mobile navigation">
      <NavLink to="/hub"><Home /><span>Home</span></NavLink>
      <NavLink to="/activity"><TimerReset /><span>Activity</span></NavLink>
      <NavLink to="/settings?section=general"><UserRound /><span>Profile</span></NavLink>
    </nav>
  );
}
