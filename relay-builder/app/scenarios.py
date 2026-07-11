"""Build a scenario's relays from the current pool and read them back for views.

Bridges the pure balancer (`balance.py`) and SQLite: resolve the scenario's
categories, pull eligible swimmers with their leg-distance time, balance each
category, and persist relays + alternates.
"""

from __future__ import annotations

import sqlite3

from .balance import assign_heats, balance_category, balance_medley, resolve_categories, swimup_columns


def _eligible(conn: sqlite3.Connection, age_groups, gender, leg):
    """Swimmers in the category's age groups (+ gender), with their leg time."""
    placeholders = ",".join("?" * len(age_groups))
    sql = f"""
        SELECT s.id AS id, s.full_name AS name, s.team AS team, s.age_group AS age_group,
               (SELECT seconds FROM times t
                  WHERE t.swimmer_id = s.id AND t.distance = ? AND t.stroke = 'Freestyle') AS secs
        FROM swimmers s
        WHERE s.age_group IN ({placeholders})
    """
    args: list = [leg, *age_groups]
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
                rows = _eligible(conn, {age}, cat["gender"], cat["leg"])
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
            rows = _eligible(conn, cat["spec"], cat["gender"], cat["leg"])
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
        SELECT l.relay_id, l.leg_order, l.seconds, s.full_name, s.team, s.age_group
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


def heat_plan(conn: sqlite3.Connection, scenario_id: int, lanes: int = 8):
    """Seed each category's relays into heats/lanes for the deck output.

    Returns (plan, cards): `plan` is per-category heats for the heat sheet;
    `cards` is a flat, program-order list of relays annotated with heat + lane
    for the relay cards.
    """
    plan, cards = [], []
    for cat in detail(conn, scenario_id):
        heats = assign_heats(cat["relays"], lanes)
        for heat in heats:
            for slot in heat["lanes"]:
                relay = slot["relay"]
                relay["heat"] = heat["heat"]
                relay["lane"] = slot["lane"]
                cards.append({"category": cat["label"], "leg": cat["leg"], **relay})
        plan.append({"label": cat["label"], "leg": cat["leg"], "heats": heats})
    return plan, cards
