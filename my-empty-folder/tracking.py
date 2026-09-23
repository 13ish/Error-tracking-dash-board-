"""
Self-hosted error tracker client for Python.

Usage:
    from tracker import init_tracker
    init_tracker(
        endpoint="https://your-tracker.example.com/api/events",
        token="YOUR_DASHBOARD_TOKEN",
        project="my-app",
    )

That's it — uncaught exceptions anywhere in the process are now reported
automatically via sys.excepthook. For an error you catch and handle
yourself but still want logged, call report_exception() manually.
"""

import sys
import traceback
import threading
import platform
import json
import urllib.request
import urllib.error

_config = {}


def init_tracker(endpoint: str, token: str, project: str = "default"):
    _config["endpoint"] = endpoint
    _config["token"] = token
    _config["project"] = project
    sys.excepthook = _handle_uncaught
    threading.excepthook = _handle_thread_exception


def _post(payload: dict):
    if not _config:
        return
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _config["endpoint"],
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-tracker-token": _config["token"],
        },
        method="POST",
    )
    try:
        # Short timeout: a down tracker must never hang or crash the
        # actual application that's trying to report an error to it.
        urllib.request.urlopen(req, timeout=3)
    except (urllib.error.URLError, OSError):
        pass  # reporting failures are swallowed on purpose, see docstring


def report_exception(exc: BaseException, context: dict | None = None):
    """Manually report an exception you caught and handled yourself."""
    _post({
        "language": "python",
        "message": f"{type(exc).__name__}: {exc}",
        "stack": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        "project": _config.get("project", "default"),
        "context": {
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            **(context or {}),
        },
    })


def _handle_uncaught(exc_type, exc_value, exc_tb):
    report_exception(exc_value)
    # Still print to stderr as normal — reporting shouldn't hide the crash
    # from whoever's watching the terminal/logs right now.
    sys.__excepthook__(exc_type, exc_value, exc_tb)


def _handle_thread_exception(args):
    report_exception(args.exc_value, context={"thread": args.thread.name})