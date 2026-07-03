export function LogoIcon({
  className = "app-logo",
  alt = "Auto-AI logo",
  loading = "lazy"
}: {
  className?: string;
  alt?: string;
  loading?: "eager" | "lazy";
}) {
  return (
    <img
      className={className}
      src="/logo.svg"
      alt={alt}
      width="64"
      height="64"
      loading={loading}
      decoding="async"
      draggable={false}
    />
  );
}
