// Credential Tracker API — Cloudflare Pages Function backed by D1 (binding: DB).
//
// Auth model: the client sends the role password as `Authorization: Bearer <pw>`
// on every request; we map it to a role here. Passwords live as encrypted Pages
// env vars (PW_ADMIN / PW_DESK / PW_MARSHAL) — never in this file. This is what
// makes "marshal is read-only" real: the server rejects writes, not the UI.
//
// Routes (all under /api):
//   POST /api/login                 {password}            -> {role}          (public)
//   GET  /api/state                                       -> {cards,directory} (any role)
//   POST /api/card/:n/:action       [{name,team,role}]    -> {card}          (desk|admin)
//   POST /api/assignments           {rows:[{n,name,...}]}                     (admin)
//   POST /api/directory             {directory}                              (admin)
//   POST /api/reset                                                          (admin)

const CARD_COUNT = 100;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function roleFor(pw, env) {
  if (!pw) return null;
  if (pw === env.PW_ADMIN)   return "admin";
  if (pw === env.PW_DESK)    return "checkinout";
  if (pw === env.PW_MARSHAL) return "marshal";
  return null;
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const seg = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const method = request.method;
  const body = async () => request.json().catch(() => ({}));

  try {
    // ---- Public: login (confirms a password and returns its role) ----------
    if (seg[0] === "login" && method === "POST") {
      const role = roleFor((await body()).password, env);
      return role ? json({ role }) : json({ error: "bad-password" }, 401);
    }

    // ---- Everything else requires a valid role -----------------------------
    const role = roleFor(bearer(request), env);
    if (!role) return json({ error: "unauthorized" }, 401);

    // ---- Read: full state (cards + contacts directory), any role -----------
    if (seg[0] === "state" && method === "GET") {
      const { results } = await env.DB
        .prepare("SELECT n, status, name, team, role, out_at FROM cards ORDER BY n")
        .all();
      const dirRow = await env.DB
        .prepare("SELECT value FROM meta WHERE key = 'directory'").first();
      let directory = {};
      try { directory = dirRow ? JSON.parse(dirRow.value) : {}; } catch {}
      return json({ cards: results, directory });
    }

    // ---- Card actions: desk or admin ---------------------------------------
    if (seg[0] === "card" && method === "POST") {
      if (role === "marshal") return json({ error: "forbidden" }, 403);
      const n = parseInt(seg[1], 10);
      const action = seg[2];
      if (!(n >= 1 && n <= CARD_COUNT)) return json({ error: "bad-card" }, 400);

      let sql, args;
      if (action === "checkout") {
        const b = await body();
        if (b.name) {   // unassigned spare — attach the walk-up holder
          sql = "UPDATE cards SET status='out', out_at=?, name=?, team=?, role=? WHERE n=?";
          args = [Date.now(), b.name, b.team ?? null, b.role ?? null, n];
        } else {
          sql = "UPDATE cards SET status='out', out_at=? WHERE n=?";
          args = [Date.now(), n];
        }
      } else if (action === "checkin" || action === "recover") {
        sql = "UPDATE cards SET status='in', out_at=NULL WHERE n=?";
        args = [n];
      } else if (action === "lost") {
        sql = "UPDATE cards SET status='lost' WHERE n=?";
        args = [n];
      } else {
        return json({ error: "bad-action" }, 400);
      }
      await env.DB.prepare(sql).bind(...args).run();
      const card = await env.DB
        .prepare("SELECT n, status, name, team, role, out_at FROM cards WHERE n=?")
        .bind(n).first();
      return json({ card });
    }

    // ---- Admin-only below --------------------------------------------------
    if (role !== "admin") return json({ error: "forbidden" }, 403);

    if (seg[0] === "assignments" && method === "POST") {
      const { rows } = await body();
      const stmts = (rows || [])
        .filter(r => r && r.n >= 1 && r.n <= CARD_COUNT && r.name)
        .map(r => env.DB
          .prepare("UPDATE cards SET name=?, team=?, role=? WHERE n=?")
          .bind(r.name, r.team ?? null, r.role ?? null, r.n));
      if (stmts.length) await env.DB.batch(stmts);
      return json({ updated: stmts.length });
    }

    if (seg[0] === "directory" && method === "POST") {
      const { directory } = await body();
      await env.DB
        .prepare("INSERT INTO meta (key, value) VALUES ('directory', ?) " +
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify(directory || {})).run();
      return json({ ok: true });
    }

    if (seg[0] === "reset" && method === "POST") {
      await env.DB.prepare("UPDATE cards SET status='in', out_at=NULL").run();
      return json({ ok: true });
    }

    return json({ error: "not-found" }, 404);
  } catch (err) {
    return json({ error: "server", detail: String(err) }, 500);
  }
}
