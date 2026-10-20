// NXT shared playbook API (Cloudflare Worker + D1). Anyone with the site link can read and save the one shared playbook.
// GET  /rev            -> { rev, updated }            (cheap check for changes)
// GET  /playbook       -> { book, rev, updated }
// PUT  /playbook       -> { rev, updated }            body: { book }   (?backup=1 forces a backup of the current version first)
// GET  /backups        -> [{ id, at, plays }]          newest first
// GET  /backups/:id    -> { book, at }

const ALLOWED = ["https://dcpeaks50.github.io", "http://localhost:8765", "null"];
const MAX_BYTES = 3_000_000;
const BACKUP_EVERY_MS = 10 * 60 * 1000;
const KEEP_BACKUPS = 40;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/rev") {
      const row = await env.DB.prepare("SELECT rev, updated FROM playbook WHERE id = 1").first();
      return json(row || { rev: 0, updated: null });
    }
    if (req.method === "GET" && path === "/playbook") {
      const row = await env.DB.prepare("SELECT json, rev, updated FROM playbook WHERE id = 1").first();
      return json(row ? { book: JSON.parse(row.json), rev: row.rev, updated: row.updated } : { book: null, rev: 0, updated: null });
    }
    if (req.method === "PUT" && path === "/playbook") {
      const text = await req.text();
      if (text.length > MAX_BYTES) return json({ error: "Playbook is too big." }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "Bad JSON." }, 400); }
      const book = body?.book;
      if (!book || !Array.isArray(book.plays) || !Array.isArray(book.formations)) return json({ error: "That isn't a playbook." }, 400);
      const now = Date.now();
      const cur = await env.DB.prepare("SELECT json, rev FROM playbook WHERE id = 1").first();
      if (cur) {
        const last = await env.DB.prepare("SELECT MAX(at) AS at FROM backups").first();
        if (url.searchParams.get("backup") === "1" || !last?.at || now - last.at > BACKUP_EVERY_MS) {
          let plays = 0; try { plays = JSON.parse(cur.json).plays.length; } catch {}
          await env.DB.batch([
            env.DB.prepare("INSERT INTO backups (at, json, plays) VALUES (?, ?, ?)").bind(now, cur.json, plays),
            env.DB.prepare(`DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY at DESC LIMIT ${KEEP_BACKUPS})`),
          ]);
        }
      }
      const rev = (cur?.rev || 0) + 1;
      await env.DB.prepare("INSERT OR REPLACE INTO playbook (id, json, rev, updated) VALUES (1, ?, ?, ?)").bind(JSON.stringify(book), rev, now).run();
      return json({ rev, updated: now });
    }
    if (req.method === "GET" && path === "/backups") {
      const { results } = await env.DB.prepare("SELECT id, at, plays FROM backups ORDER BY at DESC").all();
      return json(results);
    }
    const m = /^\/backups\/(\d+)$/.exec(path);
    if (req.method === "GET" && m) {
      const row = await env.DB.prepare("SELECT json, at FROM backups WHERE id = ?").bind(+m[1]).first();
      return row ? json({ book: JSON.parse(row.json), at: row.at }) : json({ error: "Not found." }, 404);
    }
    return json({ error: "Not found." }, 404);
  },
};
