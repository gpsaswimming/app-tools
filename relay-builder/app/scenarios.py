"""Build a scenario's relays from the current pool and read them back for views.

Bridges the pure balancer (`balance.py`) and SQLite: resolve the scenario's
categories, pull eligible swimmers with their leg-distance time, balance each
category, and persist relays + alternates.
"""

from __future__ import annotations

import sqlite3

from .balance import assign_heats, balance_category, balance_medley, resolve_categories, swimup_columns


def _eligible(conn: sqlite3.Connection, scenario_id, age_groups, gender, leg):
    """Swimmers in the category's age groups (+ gender), with their leg time.

    Deck-scratched swimmers are excluded, so a re-balance re-forms relays around
    who is actually present.
    """
    placeholders = ",".join("?" * len(age_groups))
    sql = f"""
        SELECT s.id AS id, s.full_name AS name, s.team AS team, s.age_group AS age_group,
               (SELECT seconds FROM times t
                  WHERE t.swimmer_id = s.id AND t.distance = ? AND t.stroke = 'Freestyle') AS secs
        FROM swimmers s
        WHERE s.age_group IN ({placeholders})
          AND s.id NOT IN (SELECT swimmer_id FROM relay_scratches WHERE scenario_id = ?)
    """
    args: list = [leg, *age_groups, scenario_id]
    if gender:
        sql += " AND s.gender = ?"
        args.append(gender)
    return conn.execute(sql, args).fetchall()


def _persist_relays(conn, scenario_id, cat, relays):
    for i, relay in enumerate(relays, start=1):
        total = sum(sec for _, sec in relay)
        rid = conn.execute(
            "INSERT INTO relays (scenario_id, category, leg_distance, idx, total_seconds) VALUES (?,?,?,?,?)",
            (scenario_id, cat["label"], cat["leg"], i, total),
        ).lastrowid
        for leg_order, (sid, sec) in enumerate(relay, start=1):
            conn.execute(
                "INSERT INTO relay_legs (relay_id, leg_order, swimmer_id, seconds) VALUES (?,?,?,?)",
                (rid, leg_order, sid, sec),
            )


def _alt(conn, scenario_id, cat, sid, sec, reason):
    conn.execute(
        "INSERT INTO relay_alternates (scenario_id, category, leg_distance, swimmer_id, seconds, reason)"
        " VALUES (?,?,?,?,?,?)",
        (scenario_id, cat["label"], cat["leg"], sid, sec, reason),
    )


def build(
    conn: sqlite3.Connection,
    scenario_id: int,
    grouping: str,
    gender_mode: str,
    open_leg: int | None,
    swimups: bool = True,
) -> None:
    """(Re)build all relays for a scenario. Idempotent — clears prior output first."""
    conn.execute("DELETE FROM relays WHERE scenario_id = ?", (scenario_id,))
    conn.execute("DELETE FROM relay_alternates WHERE scenario_id = ?", (scenario_id,))

    for cat in resolve_categories(grouping, gender_mode, open_leg):
        if cat["kind"] == "medley":
            # One eligible pool per age-group leg (youngest first).
            pools, no_time = [], []
            for age in cat["spec"]:
                rows = _eligible(conn, scenario_id, {age}, cat["gender"], cat["leg"])
                pools.append([(r["id"], r["secs"]) for r in rows if r["secs"] is not None])
                no_time += [r["id"] for r in rows if r["secs"] is None]
            if swimups:
                # Backfill older legs with younger swim-ups, then balance the columns.
                columns, leftovers = swimup_columns(pools)
                relays, _ = balance_medley(columns)  # columns are equal length → no extra leftovers
            else:
                relays, leftovers = balance_medley(pools)  # strict one-per-band
            _persist_relays(conn, scenario_id, cat, relays)
            for sid, sec, _col in leftovers:
                _alt(conn, scenario_id, cat, sid, sec, "remainder")
            for sid in no_time:
                _alt(conn, scenario_id, cat, sid, None, "no-time")
        else:
            rows = _eligible(conn, scenario_id, cat["spec"], cat["gender"], cat["leg"])
            seeded = [(r["id"], r["secs"]) for r in rows if r["secs"] is not None]
            no_time = [r["id"] for r in rows if r["secs"] is None]
            relays, remainder = balance_category(seeded)
            _persist_relays(conn, scenario_id, cat, relays)
            for sid, sec in remainder:
                _alt(conn, scenario_id, cat, sid, sec, "remainder")
            for sid in no_time:
                _alt(conn, scenario_id, cat, sid, None, "no-time")


def summary(conn: sqlite3.Connection, scenario_id: int) -> dict:
    """Counts for the scenarios list: relays, swimmers placed, alternates."""
    relays = conn.execute("SELECT COUNT(*) FROM relays WHERE scenario_id = ?", (scenario_id,)).fetchone()[0]
    placed = conn.execute(
        "SELECT COUNT(*) FROM relay_legs l JOIN relays r ON r.id = l.relay_id WHERE r.scenario_id = ?",
        (scenario_id,),
    ).fetchone()[0]
    alts = conn.execute(
        "SELECT COUNT(*) FROM relay_alternates WHERE scenario_id = ?", (scenario_id,)
    ).fetchone()[0]
    return {"relays": relays, "placed": placed, "alternates": alts}


def detail(conn: sqlite3.Connection, scenario_id: int) -> list[dict]:
    """Structured categories → relays (with legs) + alternates, for the detail view."""
    relays = conn.execute(
        "SELECT * FROM relays WHERE scenario_id = ? ORDER BY id", (scenario_id,)
    ).fetchall()
    legs = conn.execute(
        """
        SELECT l.relay_id, l.leg_order, l.seconds, l.swimmer_id, s.full_name, s.team, s.age_group
        FROM relay_legs l JOIN relays r ON r.id = l.relay_id JOIN swimmers s ON s.id = l.swimmer_id
        WHERE r.scenario_id = ? ORDER BY l.relay_id, l.leg_order
        """,
        (scenario_id,),
    ).fetchall()
    alts = conn.execute(
        """
        SELECT a.category, a.leg_distance, a.seconds, a.reason, s.full_name, s.team
        FROM relay_alternates a JOIN swimmers s ON s.id = a.swimmer_id
        WHERE a.scenario_id = ? ORDER BY a.category, a.reason, s.full_name
        """,
        (scenario_id,),
    ).fetchall()

    legs_by_relay: dict[int, list] = {}
    for lg in legs:
        legs_by_relay.setdefault(lg["relay_id"], []).append(lg)

    # Group relays by category, preserving insertion order.
    cats: dict[str, dict] = {}
    for r in relays:
        cat = cats.setdefault(
            r["category"], {"label": r["category"], "leg": r["leg_distance"], "relays": [], "alternates": []}
        )
        cat["relays"].append({"idx": r["idx"], "total": r["total_seconds"], "legs": legs_by_relay.get(r["id"], [])})
    for a in alts:
        cat = cats.setdefault(
            a["category"], {"label": a["category"], "leg": a["leg_distance"], "relays": [], "alternates": []}
        )
        cat["alternates"].append(a)

    # Spread = slowest total − fastest total within the category.
    out = []
    for cat in cats.values():
        totals = [rel["total"] for rel in cat["relays"]]
        cat["spread"] = (max(totals) - min(totals)) if len(totals) > 1 else 0.0
        cat["count"] = len(cat["relays"])
        out.append(cat)
    return out


def list_scratches(conn: sqlite3.Connection, scenario_id: int) -> list:
    """Swimmers currently scratched for the scenario, for the deck view."""
    return conn.execute(
        """
        SELECT s.id AS swimmer_id, s.full_name, s.team, s.age_group, s.gender
        FROM relay_scratches x JOIN swimmers s ON s.id = x.swimmer_id
        WHERE x.scenario_id = ? ORDER BY s.full_name
        """,
        (scenario_id,),
    ).fetchall()


def _pick_alternate(conn, scenario_id, category, leg_order, target_secs, cat, swimups):
    """Best available substitute for a scratched leg, or None.

    A candidate must be an alternate in the same category with an entry time (so
    'no-time' alternates are skipped) and not itself scratched. For a partition
    (free) relay any such alternate qualifies; for a medley the sub must be legal
    for that leg's age band — its own band, or a younger swim-up when swim-ups are
    on (never older). Among the legal candidates we take the one whose time is
    closest to the swimmer being replaced, so the relay total — and thus its heat
    seed — barely moves.
    """
    rows = conn.execute(
        """
        SELECT a.swimmer_id, a.seconds, s.age_group
        FROM relay_alternates a JOIN swimmers s ON s.id = a.swimmer_id
        WHERE a.scenario_id = ? AND a.category = ? AND a.seconds IS NOT NULL
          AND a.swimmer_id NOT IN (SELECT swimmer_id FROM relay_scratches WHERE scenario_id = ?)
        """,
        (scenario_id, category, scenario_id),
    ).fetchall()
    if cat["kind"] == "medley":
        bands = list(cat["spec"])  # youngest-first; leg_order 1..4 maps to index 0..3
        need_idx = leg_order - 1

        def legal(age_group):
            if age_group not in bands:
                return False
            i = bands.index(age_group)
            return i == need_idx or (swimups and i < need_idx)

        rows = [r for r in rows if legal(r["age_group"])]
    if not rows:
        return None
    return min(rows, key=lambda r: abs(r["seconds"] - target_secs))


def scratch(conn, scenario_id, swimmer_id, grouping, gender_mode, open_leg, swimups) -> dict:
    """Mark a swimmer out and patch their relay in place — a surgical deck edit.

    Records the scratch (source of truth for a later re-balance), then, if the
    swimmer was placed, fills their leg with the best available alternate
    (`_pick_alternate`). If no legal sub with a time exists, the leg is left open
    and the relay swims short. Only this one relay changes; every other printed
    card stays valid. Returns a small status dict for the caller/UI.
    """
    conn.execute(
        "INSERT OR IGNORE INTO relay_scratches (scenario_id, swimmer_id) VALUES (?,?)",
        (scenario_id, swimmer_id),
    )
    row = conn.execute(
        """
        SELECT rl.relay_id, rl.leg_order, rl.seconds AS scr_secs, r.category
        FROM relay_legs rl JOIN relays r ON r.id = rl.relay_id
        WHERE r.scenario_id = ? AND rl.swimmer_id = ?
        """,
        (scenario_id, swimmer_id),
    ).fetchone()
    if row is None:
        return {"placed": False, "subbed": False, "short": False}

    relay_id, leg_order = row["relay_id"], row["leg_order"]
    cats = {c["label"]: c for c in resolve_categories(grouping, gender_mode, open_leg)}
    cat = cats.get(row["category"])
    sub = _pick_alternate(conn, scenario_id, row["category"], leg_order, row["scr_secs"], cat, swimups) if cat else None

    if sub is not None:
        conn.execute(
            "UPDATE relay_legs SET swimmer_id = ?, seconds = ? WHERE relay_id = ? AND leg_order = ?",
            (sub["swimmer_id"], sub["seconds"], relay_id, leg_order),
        )
        conn.execute(
            "DELETE FROM relay_alternates WHERE scenario_id = ? AND swimmer_id = ?",
            (scenario_id, sub["swimmer_id"]),
        )
    else:
        conn.execute("DELETE FROM relay_legs WHERE relay_id = ? AND leg_order = ?", (relay_id, leg_order))

    total = conn.execute(
        "SELECT COALESCE(SUM(seconds), 0) FROM relay_legs WHERE relay_id = ?", (relay_id,)
    ).fetchone()[0]
    conn.execute("UPDATE relays SET total_seconds = ? WHERE id = ?", (total, relay_id))
    return {"placed": True, "subbed": sub is not None, "short": sub is None}


def unscratch(conn, scenario_id, swimmer_id) -> None:
    """Clear a scratch. The in-place sub is not auto-reversed — re-balance to fold
    the swimmer back into fresh relays."""
    conn.execute(
        "DELETE FROM relay_scratches WHERE scenario_id = ? AND swimmer_id = ?",
        (scenario_id, swimmer_id),
    )


def heat_plan(conn: sqlite3.Connection, scenario_id: int, lanes: int = 8):
    """Seed each category's relays into heats/lanes for the deck output.

    Returns (plan, cards): `plan` is per-category heats for the heat sheet;
    `cards` is a flat, program-order list of relays annotated with heat + lane
    for the relay cards.
    """
    plan, cards = [], []
    for event, cat in enumerate(detail(conn, scenario_id), start=1):
        heats = assign_heats(cat["relays"], lanes)
        for heat in heats:
            for slot in heat["lanes"]:
                relay = slot["relay"]
                relay["heat"] = heat["heat"]
                relay["lane"] = slot["lane"]
                cards.append({"category": cat["label"], "event": event, "leg": cat["leg"], **relay})
        plan.append({"label": cat["label"], "event": event, "leg": cat["leg"], "heats": heats})
    return plan, cards


def timeline(
    conn: sqlite3.Connection,
    scenario_id: int,
    *,
    start_seconds: int,
    gap: int,
    lanes: int = 8,
) -> dict:
    """Estimated running order for a session: each event's clock start time.

    Events run in program order (same order as the heat sheet). A heat runs all
    lanes at once, so its wall-clock cost is the **slowest relay in the heat** —
    its seeded total — plus ``gap``, the seconds to clear the pool and get the
    next heat set. An event's block is the sum of its heats; the clock advances
    event to event, the trailing gap doubling as setup before the next event.

    Seeded totals are the sum of four flat-start free seed times, so they run a
    touch long versus actual relay splits (flying exchanges) — a conservative,
    ready-early estimate, which is the safe direction for a posted timeline.
    """
    plan, _ = heat_plan(conn, scenario_id, lanes)
    running = start_seconds
    rows = []
    for cat in plan:
        duration = 0.0
        for heat in cat["heats"]:
            slowest = max((slot["relay"]["total"] for slot in heat["lanes"]), default=0.0)
            duration += slowest + gap
        rows.append(
            {
                "event": cat["event"],
                "label": cat["label"],
                "leg": cat["leg"],
                "heats": len(cat["heats"]),
                "start": running,
                "duration": duration,
            }
        )
        running += duration
    return {"rows": rows, "start": start_seconds, "end": running, "total": running - start_seconds}


def team_reports(conn: sqlite3.Connection, scenario_id: int, lanes: int = 8) -> list[dict]:
    """Per-team participant lists for the deck. Each relay swimmer becomes a row
    on their own team's report with the event, heat, and lane they swim in — so a
    pooled relay's swimmers can be handed back to their home teams. Returns a list
    of {team, entries[]} sorted by team, entries sorted by event/heat/lane.
    """
    _, cards = heat_plan(conn, scenario_id, lanes)
    teams: dict[str, list] = {}
    for c in cards:
        for leg in c["legs"]:
            teams.setdefault(leg["team"] or "?", []).append(
                {
                    "swimmer": leg["full_name"],
                    "age_group": leg["age_group"],
                    "event": c["event"],
                    "event_label": c["category"],
                    "leg": c["leg"],
                    "heat": c["heat"],
                    "lane": c["lane"],
                    "relay_idx": c["idx"],
                    "leg_order": leg["leg_order"],
                }
            )
    out = []
    for team in sorted(teams):
        entries = sorted(teams[team], key=lambda e: (e["swimmer"].lower(), e["event"]))
        out.append({"team": team, "entries": entries})
    return out
