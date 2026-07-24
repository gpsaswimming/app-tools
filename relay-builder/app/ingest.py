"""Upsert a parsed NormalizedMeet into the swimmer pool.

Idempotent: importing the same file again (or a corrected one) updates the
affected swimmers and times in place instead of duplicating them. This is what
makes both bulk import (many files at once) and incremental import (one team's
file arriving later) work with the same code path.

Only relay opt-ins are pooled. A swimmer signals opt-in by being entered in one
of the placeholder relay sign-up events (53A-D, 54A-H) in the team entry file; a
swimmer with no entry in any of those events is dropped entirely, times and all,
so the pool is exactly the swimmers who asked to swim a relay.
"""

from __future__ import annotations

import sqlite3

# Placeholder events a swimmer is entered in to opt into a pooled relay. Only
# swimmers with an entry in one of these are pooled (see module docstring).
RELAY_OPT_IN_EVENTS = frozenset(
    {f"53{c}" for c in "ABCD"} | {f"54{c}" for c in "ABCDEFGH"}
)


def _opted_in_swimmer_ids(meet: dict) -> set[str]:
    """Ids of swimmers entered in a relay opt-in event (53A-D, 54A-H)."""
    opted_in: set[str] = set()
    for ev in meet.get("events") or []:
        if str(ev.get("number") or "").strip().upper() not in RELAY_OPT_IN_EVENTS:
            continue
        for r in ev.get("results") or []:
            sid = r.get("swimmerId")
            if sid is not None:
                opted_in.add(sid)
    return opted_in


def ingest_meet(conn: sqlite3.Connection, meet: dict, *, filename: str) -> dict:
    """Insert/update relay opt-in swimmers and their free times from one meet.

    Swimmers without an entry in a relay opt-in event (53A-D, 54A-H) are skipped
    entirely. Returns a small summary for the import log.
    """
    all_swimmers = meet.get("swimmers") or []
    team = all_swimmers[0]["teamCode"] if all_swimmers else None
    opted_in = _opted_in_swimmer_ids(meet)
    swimmers = [s for s in all_swimmers if s["id"] in opted_in]

    for s in swimmers:
        conn.execute(
            """
            INSERT INTO swimmers (id, full_name, last_name, first_name, gender, age_group, team)
            VALUES (:id, :full_name, :last_name, :first_name, :gender, :age_group, :team)
            ON CONFLICT(id) DO UPDATE SET
                full_name = excluded.full_name,
                last_name = excluded.last_name,
                first_name = excluded.first_name,
                gender    = excluded.gender,
                age_group = excluded.age_group,
                team      = excluded.team
            """,
            {
                "id": s["id"],
                "full_name": s.get("fullName", ""),
                "last_name": s.get("lastName"),
                "first_name": s.get("firstName"),
                "gender": s.get("gender"),
                "age_group": s.get("ageGroup"),
                "team": s.get("teamCode"),
            },
        )

    time_count = 0
    for ev in meet.get("events") or []:
        if ev.get("type") != "individual":
            continue
        distance, stroke = ev.get("distance"), ev.get("stroke")
        if not distance or not stroke:
            continue
        for r in ev.get("results") or []:
            seed = r.get("seedTime")
            sid = r.get("swimmerId")
            secs = seed.get("seconds") if seed else None
            # Skip swimmers who didn't opt in (not pooled) and "no time" entries —
            # swimparse reports NT/blank seeds as 0, which would otherwise sort as
            # impossibly fast and poison a relay.
            if sid is None or sid not in opted_in or not secs or secs <= 0:
                continue
            conn.execute(
                """
                INSERT INTO times (swimmer_id, distance, stroke, seconds)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(swimmer_id, distance, stroke) DO UPDATE SET seconds = excluded.seconds
                """,
                (sid, distance, stroke, secs),
            )
            time_count += 1

    conn.execute(
        "INSERT INTO imports (filename, fmt, team, swimmers) VALUES (?, ?, ?, ?)",
        (filename, meet.get("format"), team, len(swimmers)),
    )
    return {
        "team": team,
        "swimmers": len(swimmers),
        "times": time_count,
        "skipped": len(all_swimmers) - len(swimmers),
    }
