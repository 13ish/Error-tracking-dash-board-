/**
 * Drop-in browser error capture for JS and HTML-page errors.
 *
 * Usage:
 *   <script src="/sdk/browser.js"></script>
 *   <script>
 *     ErrorTracker.init({
 *       endpoint: "https://your-tracker.example.com/api/events",
 *       token: "YOUR_DASHBOARD_TOKEN",
 *       project: "my-website"
 *     });
 *   </script>
 *
 * Captures: uncaught JS exceptions, unhandled promise rejections, and
 * resource load failures (broken <img>/<script>/<link> — the closest thing
 * to an "HTML error").
 */
(function () {
  let config = null;

  function send(payload) {
    if (!config) return;
    fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tracker-token": config.token },
      body: JSON.stringify({ project: config.project || "default", ...payload })
    }).catch(() => {}); // never let the reporter itself throw and loop
  }

  function init(opts) {
    config = opts;

    window.addEventListener("error", (e) => {
      // Resource load failures (img/script/link) arrive here too, without
      // a real Error object — detect that case separately.
      if (e.target && e.target !== window && e.target.tagName) {
        send({
          language: "html",
          message: `Failed to load <${e.target.tagName.toLowerCase()}>: ${e.target.src || e.target.href || "unknown source"}`,
          file: location.href,
          context: { userAgent: navigator.userAgent }
        });
        return;
      }
      send({
        language: "javascript",
        message: e.message || "Unknown error",
        stack: e.error?.stack || null,
        file: e.filename || location.href,
        line: e.lineno || null,
        context: { userAgent: navigator.userAgent, url: location.href }
      });
    }, true);

    window.addEventListener("unhandledrejection", (e) => {
      const reason = e.reason;
      send({
        language: "javascript",
        message: `Unhandled promise rejection: ${reason?.message || String(reason)}`,
        stack: reason?.stack || null,
        file: location.href,
        context: { userAgent: navigator.userAgent, url: location.href }
      });
    });
  }

  window.ErrorTracker = { init, report: send };
})();