import { useId } from "react";

export type AutoAiLogoProps = {
  className?: string;
  alt?: string;
  loading?: "eager" | "lazy";
};

/**
 * Network-independent application logo. Rendering the mark as inline SVG avoids
 * route-depth, cache, MIME-type, CDN, Railway, case-sensitivity and Capacitor
 * asset URL failures. It never renders a browser broken-image placeholder.
 */
export function AutoAiLogo({
  className = "app-logo",
  alt = "AutoAI",
  loading = "lazy"
}: AutoAiLogoProps) {
  void loading;
  const id = useId().replace(/:/g, "");
  const edgeId = `${id}-autoai-edge`;
  const metalId = `${id}-autoai-metal`;
  const labelled = Boolean(alt);

  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      width="64"
      height="64"
      preserveAspectRatio="xMidYMid meet"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? alt : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-autoai-logo="inline-v2"
      style={{ display: "block", width: "100%", height: "100%", flex: "0 0 auto" }}
    >
      <defs>
        <linearGradient id={edgeId} x1="6" y1="10" x2="58" y2="54" gradientUnits="userSpaceOnUse">
          <stop stopColor="#22f5ff" />
          <stop offset="0.52" stopColor="#e8f3f7" />
          <stop offset="1" stopColor="#ffb21e" />
        </linearGradient>
        <linearGradient id={metalId} x1="18" y1="16" x2="48" y2="45" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f8fbff" />
          <stop offset="0.48" stopColor="#aeb9bd" />
          <stop offset="1" stopColor="#ffbf35" />
        </linearGradient>
      </defs>

      <rect x="3" y="3" width="58" height="58" rx="14" fill="#070b0f" />
      <rect x="5" y="5" width="54" height="54" rx="12" fill="#0b1116" stroke={`url(#${edgeId})`} strokeWidth="2" />
      <path d="M9 32h8l6-6h5M9 39h13l4-4h4M42 28h5l4-4h4M43 36h8l4 4" fill="none" stroke="#18dff0" strokeOpacity="0.35" strokeWidth="1.2" />
      <path d="M15 42 28.8 17.5c1.5-2.7 4.9-2.7 6.4 0L49 42" fill="none" stroke="#111820" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 42 28.8 17.5c1.5-2.7 4.9-2.7 6.4 0L49 42" fill="none" stroke={`url(#${metalId})`} strokeWidth="7.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 39 31.2 17.8c.4-.7 1.2-.7 1.6 0L45 39" fill="none" stroke="#ffffff" strokeOpacity="0.34" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M15 29a19 19 0 0 1 35-7M49 25a17 17 0 0 1 1 14" fill="none" stroke="#25f4ff" strokeWidth="3.2" strokeLinecap="round" opacity="0.92" />
      <circle cx="15" cy="35" r="3.4" fill="#5effff" />
      <circle cx="50" cy="25" r="3.5" fill="#ffc454" />
      <rect x="22" y="35" width="20" height="12" rx="5.5" fill="#05090d" stroke={`url(#${metalId})`} strokeWidth="1.8" />
      <path d="M32 35v-5" stroke="#eafcff" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="32" cy="29" r="2.3" fill="#30f3ff" />
      <rect x="27" y="39" width="3" height="5" rx="1.5" fill="#36f8ff" />
      <rect x="34" y="39" width="3" height="5" rx="1.5" fill="#36f8ff" />
    </svg>
  );
}

// Compatibility export used throughout the existing application.
export const LogoIcon = AutoAiLogo;
