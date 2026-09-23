import "dotenv/config";
import express from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

// Shared secret every SDK and the dashboard itself must send. Required —
// this thing stores stack traces, file paths and possibly fragments of
// your source; it should never be open on the internet with no auth.
const TOKEN = process.env.DASHBOARD_TOKEN;
if (!TOKEN || TOKEN.length < 16) {
  console.error("FATAL: set DASHBOARD_TOKEN (16+ chars) in your environment before starting.");
  process.exit(1);
}

// Optional. Without it, the app works fully as a tracker/dashboard — you
// just won't get the "suggest a fix" button's AI-generated suggestions.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

const db = new Database(path.join(__dirname, "events.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT 'default',
  language TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  file TEXT,
  line INTEGER,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_fp ON events(fingerprint);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS groups (
  fingerprint TEXT PRIMARY KEY,
  resolved INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suggestions (
  fingerprint TEXT PRIMARY KEY,
  suggestion TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Groups identical errors together so the dashboard shows "this crash
// happened 340 times" instead of 340 separate rows — the core thing that
// makes an error tracker useful instead of just a log file.
function fingerprint(language, message, stack) {
  const topFrame = (stack || "").split("\n")[1] || (stack || "").split("\n")[0] || "";
  return crypto.createHash("sha1")
    .update(`${language}::${message}::${topFrame}`)
    .digest("hex");
}

function requireToken(req, res, next) {
  const provided = req.headers["x-tracker-token"];
  if (!provided || provided !== TOKEN) {
    return res.status(401).json({ success: false, error: "Invalid or missing token" });
  }
  next();
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------------------------------------------ */
/* Ingestion — every language SDK posts here                          */
/* ------------------------------------------------------------------ */
app.post("/api/events", requireToken, (req, res) => {
  try {
    const { language, message, stack, file, line, context, project } = req.body || {};
    if (typeof language !== "string" || typeof message !== "string") {
      return res.status(400).json({ success: false, error: "language and message are required" });
    }

    const fp = fingerprint(language, message, stack);
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO events (fingerprint, project, language, message, stack, file, line, context)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fp, project || "default", language, message, stack || null, file || null,
           Number.isFinite(line) ? line : null, context ? JSON.stringify(context) : null);

    const existing = db.prepare("SELECT * FROM groups WHERE fingerprint = ?").get(fp);
    if (existing) {
      db.prepare("UPDATE groups SET last_seen = ?, count = count + 1 WHERE fingerprint = ?").run(now, fp);
    } else {
      db.prepare("INSERT INTO groups (fingerprint, first_seen, last_seen, count) VALUES (?, ?, ?, 1)")
        .run(fp, now, now);
    }

    res.json({ success: true, fingerprint: fp });
  } catch (err) {
    console.error("ingest error:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ------------------------------------------------------------------ */
/* Dashboard reads — also token-gated, since stack traces can leak     */
/* file paths, usernames, internal structure                          */
/* ------------------------------------------------------------------ */
app.get("/api/groups", requireToken, (req, res) => {
  const { language, project, resolved } = req.query;
  let sql = `
    SELECT g.fingerprint, g.resolved, g.first_seen, g.last_seen, g.count,
           e.language, e.message, e.project
    FROM groups g
    JOIN events e ON e.fingerprint = g.fingerprint
    WHERE e.id = (SELECT MAX(id) FROM events WHERE fingerprint = g.fingerprint)
  `;
  const params = [];
  if (language) { sql += " AND e.language = ?"; params.push(language); }
  if (project)  { sql += " AND e.project = ?"; params.push(project); }
  if (resolved !== undefined) { sql += " AND g.resolved = ?"; params.push(Number(resolved)); }
  sql += " ORDER BY g.last_seen DESC LIMIT 200";
  res.json({ success: true, groups: db.prepare(sql).all(...params) });
});

app.get("/api/groups/:fp", requireToken, (req, res) => {
  const fp = req.params.fp;
  const group = db.prepare("SELECT * FROM groups WHERE fingerprint = ?").get(fp);
  if (!group) return res.status(404).json({ success: false, error: "Not found" });
  const occurrences = db.prepare(
    "SELECT * FROM events WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 50"
  ).all(fp);
  const suggestion = db.prepare("SELECT * FROM suggestions WHERE fingerprint = ?").get(fp);
  res.json({ success: true, group, occurrences, suggestion: suggestion || null });
});

app.post("/api/groups/:fp/resolve", requireToken, (req, res) => {
  db.prepare("UPDATE groups SET resolved = 1 WHERE fingerprint = ?").run(req.params.fp);
  res.json({ success: true });
});

app.get("/api/stats", requireToken, (req, res) => {
  const byLanguage = db.prepare(
    "SELECT language, COUNT(*) as count FROM events GROUP BY language ORDER BY count DESC"
  ).all();
  const byDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM events WHERE created_at >= datetime('now', '-14 days')
    GROUP BY day ORDER BY day ASC
  `).all();
  const totals = db.prepare("SELECT COUNT(*) as events FROM events").get();
  const openGroups = db.prepare("SELECT COUNT(*) as n FROM groups WHERE resolved = 0").get();
  res.json({ success: true, byLanguage, byDay, totalEvents: totals.events, openGroups: openGroups.n });
});

/* ------------------------------------------------------------------ */
/* AI fix suggestion — explicitly NOT an auto-patch. Returns an        */
/* explanation plus an illustrative snippet; nothing is written back   */
/* into your source files. You read it, you decide, you apply it.     */
/* ------------------------------------------------------------------ */
app.post("/api/groups/:fp/suggest", requireToken, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "No ANTHROPIC_API_KEY configured — set one in .env to enable suggestions."
    });
  }
  try {
    const fp = req.params.fp;
    const cached = db.prepare("SELECT * FROM suggestions WHERE fingerprint = ?").get(fp);
    if (cached && !req.query.refresh) {
      return res.json({ success: true, suggestion: cached.suggestion, cached: true });
    }

    const latest = db.prepare(
      "SELECT * FROM events WHERE fingerprint = ? ORDER BY id DESC LIMIT 1"
    ).get(fp);
    if (!latest) return res.status(404).json({ success: false, error: "Not found" });

    const prompt = `You are reviewing a production error from a ${latest.language} application.

Message: ${latest.message}
File: ${latest.file || "unknown"}${latest.line ? `:${latest.line}` : ""}
Stack trace:
${latest.stack || "(none provided)"}

Give exactly three sections, each 2-4 sentences unless a short illustrative
code snippet is genuinely needed to make the fix concrete:

1. ROOT CAUSE — what is actually going wrong, precisely, not a generic guess.
2. FIX — how to fix it. You may include a short (under 15 line) illustrative
   snippet showing the pattern, but do not attempt to output the person's
   full corrected file — you don't have it, and guessing at surrounding
   code you haven't seen would be misleading.
3. SIMPLIFY — a suggestion for making this code path smaller or less
   complex going forward, if there's a genuine opportunity here; say
   "no obvious simplification" if there isn't one, rather than inventing one.

If you are not confident about the root cause from the information given, say
so explicitly rather than guessing — a wrong confident answer is worse than
an honest "the stack trace doesn't show enough to be sure, here's what to
check next."`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return res.status(502).json({ success: false, error: "AI suggestion request failed" });
    }

    const data = await response.json();
    const text = (data.content || []).map(b => b.text || "").join("\n").trim();

    db.prepare(`
      INSERT INTO suggestions (fingerprint, suggestion, created_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(fingerprint) DO UPDATE SET suggestion = excluded.suggestion, created_at = excluded.created_at
    `).run(fp, text);

    res.json({ success: true, suggestion: text, cached: false });
  } catch (err) {
    console.error("suggest error:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Error tracker listening on :${PORT}`);
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
});