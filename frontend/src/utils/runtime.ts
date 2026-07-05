export function isMobileAppRuntime() {
  if (typeof window === "undefined") return false;
  const { protocol, hostname } = window.location;
  return protocol === "https:" && hostname === "localhost";
}
