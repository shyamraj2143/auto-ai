// Production web deployments use the frontend origin as the API origin.
// This prevents stale VITE_API_URL values from bypassing the nginx same-origin proxy.
// v20260821-2: force a fresh deployment after the production API routing fix.
(function () {
  if (typeof window === "undefined") return;
  var protocol = window.location.protocol;
  var hostname = window.location.hostname;
  var isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  var isMobileWebView = protocol === "https:" && hostname === "localhost";
  if (!isLocal && !isMobileWebView) {
    window.__AUTO_AI_API_URL__ = window.location.origin + "/api/v1";
  }
})();
