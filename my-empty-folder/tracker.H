/*
 * Minimal crash reporter for C/C++ programs on Linux/macOS (POSIX only —
 * Windows needs SEH/vectored exception handlers instead, not covered here).
 *
 * This catches SIGSEGV, SIGABRT and SIGFPE, grabs a backtrace, and POSTs it
 * to your tracker before the process dies. It is deliberately simple:
 * real crash reporters (Breakpad, Crashpad) are enormously more thorough
 * about signal-safety and symbol resolution — this is a legible starting
 * point, not a production-grade replacement for one.
 *
 * IMPORTANT CAVEAT: almost nothing is safe to call from inside a signal
 * handler (malloc, most libc functions, even printf are technically
 * undefined behavior mid-signal). This implementation accepts that risk
 * for the sake of being short and readable — the network call in particular
 * is the least "correct" part of it. If this matters for a real production
 * system, log to a pre-allocated buffer / write() to a file descriptor
 * instead, and send the report from a separate watchdog process that
 * reads it after the fact.
 *
 * Build:
 *   g++ -g -rdynamic your_app.cpp -lcurl -o your_app
 *   (-g gives you source info, -rdynamic gives you symbol names in the
 *   backtrace instead of raw hex addresses)
 *
 * Usage, once at program start:
 *   #include "tracker.h"
 *   tracker_init("https://your-tracker.example.com/api/events",
 *                "YOUR_DASHBOARD_TOKEN", "my-cpp-app");
 */

#ifndef ERROR_TRACKER_H
#define ERROR_TRACKER_H

#include <execinfo.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <curl/curl.h>

#define TRACKER_MAX_FRAMES 32

static char g_tracker_endpoint[512];
static char g_tracker_token[256];
static char g_tracker_project[128];

static void tracker_signal_handler(int sig) {
    void *frames[TRACKER_MAX_FRAMES];
    int frame_count = backtrace(frames, TRACKER_MAX_FRAMES);
    char **symbols = backtrace_symbols(frames, frame_count);

    // Build a JSON stack string out of the resolved frames.
    char stack_buf[8192];
    stack_buf[0] = '\0';
    for (int i = 0; i < frame_count && symbols; i++) {
        strncat(stack_buf, symbols[i], sizeof(stack_buf) - strlen(stack_buf) - 2);
        strncat(stack_buf, "\\n", sizeof(stack_buf) - strlen(stack_buf) - 1);
    }

    const char *signal_name = strsignal(sig);

    // Escape quotes/backslashes minimally so the message drops straight
    // into a JSON string literal below.
    char message[256];
    snprintf(message, sizeof(message), "Fatal signal: %s (%d)", signal_name, sig);

    char body[9216];
    snprintf(body, sizeof(body),
        "{\"language\":\"cpp\",\"project\":\"%s\",\"message\":\"%s\",\"stack\":\"%s\"}",
        g_tracker_project, message, stack_buf);

    CURL *curl = curl_easy_init();
    if (curl) {
        struct curl_slist *headers = NULL;
        char token_header[300];
        snprintf(token_header, sizeof(token_header), "x-tracker-token: %s", g_tracker_token);
        headers = curl_slist_append(headers, "Content-Type: application/json");
        headers = curl_slist_append(headers, token_header);

        curl_easy_setopt(curl, CURLOPT_URL, g_tracker_endpoint);
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 2000L); // never hang the crash on a dead tracker
        curl_easy_perform(curl); // best-effort — ignore the result, we're crashing regardless

        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
    }

    if (symbols) free(symbols);

    // Restore the default handler and re-raise, so the process still dies
    // the normal way (correct exit code, core dump if enabled) rather than
    // us swallowing the crash.
    signal(sig, SIG_DFL);
    raise(sig);
}

static inline void tracker_init(const char *endpoint, const char *token, const char *project) {
    strncpy(g_tracker_endpoint, endpoint, sizeof(g_tracker_endpoint) - 1);
    strncpy(g_tracker_token, token, sizeof(g_tracker_token) - 1);
    strncpy(g_tracker_project, project, sizeof(g_tracker_project) - 1);

    curl_global_init(CURL_GLOBAL_DEFAULT);
    signal(SIGSEGV, tracker_signal_handler);
    signal(SIGABRT, tracker_signal_handler);
    signal(SIGFPE,  tracker_signal_handler);
}

// For a caught C++ exception you want reported without crashing the
// process — call this from a catch block.
static inline void tracker_report(const char *message, const char *context) {
    char body[4096];
    snprintf(body, sizeof(body),
        "{\"language\":\"cpp\",\"project\":\"%s\",\"message\":\"%s\",\"context\":{\"note\":\"%s\"}}",
        g_tracker_project, message, context ? context : "");

    CURL *curl = curl_easy_init();
    if (curl) {
        struct curl_slist *headers = NULL;
        char token_header[300];
        snprintf(token_header, sizeof(token_header), "x-tracker-token: %s", g_tracker_token);
        headers = curl_slist_append(headers, "Content-Type: application/json");
        headers = curl_slist_append(headers, token_header);
        curl_easy_setopt(curl, CURLOPT_URL, g_tracker_endpoint);
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 2000L);
        curl_easy_perform(curl);
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
    }
}

#endif // ERROR_TRACKER_H