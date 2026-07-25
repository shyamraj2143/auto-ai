import { ArrowRight, History } from "lucide-react";
import type { HubFeatureTone } from "./FeatureCard";

export type HubActivityItem = {
  id: string;
  tone: HubFeatureTone;
  label: string;
  title: string;
  meta: string;
  onOpen?: () => void;
};

export function RecentActivity({ items, loading, error, expanded = false }: {
  items: HubActivityItem[];
  loading: boolean;
  error?: string;
  expanded?: boolean;
}) {
  return (
    <section className="hub-recents" aria-labelledby="hub-recents-title">
      <div className="hub-section-heading">
        <div>
          <p>{expanded ? "Your workspace timeline" : "Resume real activity"}</p>
          <h2 id="hub-recents-title">{expanded ? "Recent Activity" : "Continue where you left off"}</h2>
        </div>
      </div>
      {error && <p className="hub-inline-error" role="status">{error}</p>}
      {loading ? (
        <div className="hub-activity-loading" role="status"><span /> Loading recent activity…</div>
      ) : items.length ? (
        <div className={`hub-recent-grid${expanded ? " is-expanded" : ""}`}>
          {items.map((item) => {
            const content = <><span className="hub-recent-icon"><History /></span><span><small>{item.label}</small><strong>{item.title}</strong><em>{item.meta}</em></span>{item.onOpen && <ArrowRight />}</>;
            return item.onOpen
              ? <button type="button" className={`hub-recent-card hub-recent-${item.tone}`} key={item.id} onClick={item.onOpen}>{content}</button>
              : <div className={`hub-recent-card hub-recent-${item.tone}`} key={item.id}>{content}</div>;
          })}
        </div>
      ) : (
        <div className="hub-empty-state">
          <History />
          <div><strong>No recent activity yet</strong><p>Start a chat, screen share, or call and it will appear here.</p></div>
        </div>
      )}
    </section>
  );
}
