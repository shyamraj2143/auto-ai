// Browser web deployments use the frontend origin as the API origin.
// This keeps API traffic same-origin and avoids browser CORS failures.
(function () {
  if (typeof window === "undefined") return;
  var hostname = window.location.hostname;
  if (hostname === "autoai.site.je" || hostname === "www.autoai.site.je") {
    window.__AUTO_AI_API_URL__ = window.location.origin + "/api/v1";
  }
})();
