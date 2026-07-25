import type { LucideIcon } from "lucide-react";

export type HubFeatureTone = "ai" | "screen" | "call";

type FeatureAction = {
  label: string;
  onClick: () => void;
};

export function FeatureCard({
  tone,
  icon: Icon,
  title,
  description,
  details,
  primaryAction,
  secondaryAction,
}: {
  tone: HubFeatureTone;
  icon: LucideIcon;
  title: string;
  description: string;
  details: string;
  primaryAction: FeatureAction;
  secondaryAction?: FeatureAction;
}) {
  return (
    <article className={`hub-feature-card hub-feature-card-${tone}`}>
      <span className="hub-feature-icon" aria-hidden="true"><Icon /></span>
      <div className="hub-feature-copy">
        <h2>{title}</h2>
        <p>{description}</p>
        <small>{details}</small>
        <div className="hub-feature-actions">
          <button type="button" className="hub-feature-primary" onClick={primaryAction.onClick}>
            {primaryAction.label}<span aria-hidden="true">›</span>
          </button>
          {secondaryAction && (
            <button type="button" className="hub-feature-secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
