Self-hosted error tracker

A small Sentry-style error tracker: ingests errors from JS/HTML, Python, and C/C++, groups identical ones together, and (optionally) asks Claude to suggest a fix. Runs as one Node process + one SQLite file — no external database, no third-party service required.

What it deliberately does NOT do
It never rewrites your source files. "Get fix suggestion" returns an explanation and, where useful, a short illustrative snippet — it does not patch your codebase. You read it, you decide, you apply it yourself.
It doesn't guess when it isn't sure. The AI prompt explicitly tells the model to say "not enough information" rather than invent a confident-sounding but wrong root cause. If a suggestion reads as vague or hedged, that's the honest answer, not a bug in the prompt.
It isn't Breakpad/Crashpad. The C/C++ signal handler here is deliberately simple and says so in its own comments — real production crash reporters are far more careful about signal-safety. Treat tracker.h as a legible starting point, not a drop-in for a system where crash-reporting robustness really matters.
Setup
bash
npm install
cp .env.example .env   # fill in DASHBOARD_TOKEN, optionally ANTHROPIC_API_KEY
npm start

Open http://localhost:4000 and enter the same DASHBOARD_TOKEN you set in .env — the dashboard itself is token-gated, since stack traces can leak file paths and internal structure and shouldn't sit open on the internet.

Wiring up each language

JavaScript / HTML — include the SDK, then call init() once:

html
<script src="/sdk/browser.js"></script>
<script>
  ErrorTracker.init({
    endpoint: "http://localhost:4000/api/events",
    token: "YOUR_DASHBOARD_TOKEN",
    project: "my-website"
  });
</script>

Catches uncaught JS exceptions, unhandled promise rejections, and broken resource loads (a stand-in for "HTML errors" — there's no such thing as an HTML runtime exception the way JS/Python have one).

Python:

python
from tracker import init_tracker
init_tracker(
    endpoint="http://localhost:4000/api/events",
    token="YOUR_DASHBOARD_TOKEN",
    project="my-app",
)

Uncaught exceptions (main thread and spawned threads) report automatically. Call report_exception(e) manually for anything you catch and handle yourself but still want logged.

C/C++ (Linux/macOS):

cpp
#include "tracker.h"
int main() {
    tracker_init("http://localhost:4000/api/events", "YOUR_DASHBOARD_TOKEN", "my-cpp-app");
    // ...
}
bash
g++ -g -rdynamic your_app.cpp -lcurl -o your_app

Catches SIGSEGV/SIGABRT/SIGFPE and reports a backtrace before the process dies as it normally would. -g -rdynamic are required to get readable function names instead of bare addresses. Windows isn't covered — it needs SEH/vectored exception handlers, a different mechanism entirely.

Other languages: the ingestion endpoint is just POST /api/events with a JSON body {language, message, stack, file, line, context, project} and an x-tracker-token header. Any language that can make an HTTP POST (Go, Rust, Java, Ruby, PHP...) can report to this with a few lines of code — the four above are just the ones with a ready-made client here.

Architecture, briefly
SDK (any language) --POST--> /api/events --> SQLite (events + groups)
                                                      |
Dashboard (public/dashboard.html) <--GET-- /api/groups, /api/stats
                                                      |
                              "Get fix suggestion" --> /api/groups/:fp/suggest
                                                        --> Anthropic API (optional)
Fingerprinting (in server.js) hashes language + message + top stack frame so 500 identical crashes become one row with a "500×" badge, instead of scrolling through 500 near-duplicate entries — the thing that actually makes a tracker useful instead of a raw log.
Suggestions are cached per fingerprint (suggestions table), so you aren't re-paying an API call every time you reopen the same error; hit "Regenerate" to force a fresh one.
On "more complex but simpler and smaller at the same time"

That's a real tension, not just a tone request, so here's how this project actually resolves it rather than hand-waving:

Complex where it has to be: fingerprint-based grouping, per-language ingestion, and the AI-suggestion cache are all things a "just log to a file" approach can't give you, and they're the actual value of a tracker over console.error.
Simple everywhere else: one server file, one dashboard file, no message queue, no separate database server, no build step, no framework on the frontend. SQLite is a single file you can cp for a backup.
Where to add complexity later, if you actually need it: multi-project auth (per-project tokens instead of one shared one), Slack/email alerts on new error groups, source-map support for minified JS stack traces, a retention/cleanup job for old events. Don't build these until a real need shows up — each one is a genuine chunk of added surface area, and the whole point of this version is that it's small enough to fully understand in one sitting.
Environment variables
Variable	Required	Purpose
DASHBOARD_TOKEN	Yes, 16+ chars	Shared secret for both ingestion and dashboard reads
ANTHROPIC_API_KEY	No	Enables the "Get fix suggestion" button; without it, everything else still works
PORT	No	Defaults to 4000