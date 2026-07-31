import { useState } from "react";
import autoAiLogo from "../../assets/auto-ai-logo.svg?no-inline";
import autoAiLogoFallback from "../../assets/auto-ai-logo-fallback.svg?no-inline";

export type AutoAiLogoProps = {
  className?: string;
  alt?: string;
  loading?: "eager" | "lazy";
};

/**
 * The only application-brand logo surface. Vite fingerprints both image assets,
 * so route depth, static-host rewrites, and stale root-relative URLs cannot break it.
 */
export function AutoAiLogo({
  className = "app-logo",
  alt = "AutoAI",
  loading = "lazy"
}: AutoAiLogoProps) {
  const [asset, setAsset] = useState<"primary" | "fallback" | "symbol">("primary");

  if (asset === "symbol") {
    return <span aria-label={alt || undefined} aria-hidden={alt ? undefined : true} className={`${className} autoai-logo-fallback`} role={alt ? "img" : undefined}>A</span>;
  }

  return <img
    className={className}
    src={asset === "primary" ? autoAiLogo : autoAiLogoFallback}
    alt={alt}
    width="64"
    height="64"
    loading={loading}
    decoding="async"
    draggable={false}
    onError={() => setAsset((current) => current === "primary" ? "fallback" : "symbol")}
  />;
}

// Compatibility export: every existing surface now receives the centralized component.
export const LogoIcon = AutoAiLogo;
