import type { ReactNode } from "react";
import { useState } from "react";
import { resolveApiAssetUrl } from "../../api/client";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function CallAvatar({
  name,
  avatarUrl,
  className = "call-user-avatar",
  children,
}: {
  name: string;
  avatarUrl?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const resolvedUrl = resolveApiAssetUrl(avatarUrl);
  const [failedUrl, setFailedUrl] = useState("");
  const showImage = Boolean(resolvedUrl && failedUrl !== resolvedUrl);

  return (
    <span className={className}>
      {showImage ? (
        <img
          src={resolvedUrl}
          alt={`${name} profile`}
          onError={() => setFailedUrl(resolvedUrl)}
        />
      ) : null}
      <span className="call-avatar-fallback" hidden={showImage} aria-hidden="true">{initials(name)}</span>
      {children}
    </span>
  );
}
