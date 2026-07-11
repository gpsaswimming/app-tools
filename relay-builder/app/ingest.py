"""Upsert a parsed NormalizedMeet into the swimmer pool.

Idempotent: importing the same file again (or a corrected one) updates the
affected swimmers and times in place instead of duplicating them. This is what
makes both bulk import (many files at once) and incremental import (one team's
file arriving later) work with the same code path.
"""

from __future__ import annotations

import sqlite3


def ingest_meet(conn: sqlite3.Connection, meet: dict, *, filename: str) -> dict:
    """Insert/update swimmers and free times from one parsed meet.

    Returns a small summary for the import log.
    """
    swimmers = meet.get("swimmers") or []
    team = swimmers[0]["teamCode"] if swimmers else None

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
            # Skip "no time" entries — swimparse reports NT/blank seeds as 0, which
            # would otherwise sort as impossibly fast and poison a relay.
            if sid is None or not secs or secs <= 0:
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
    return {"team": team, "swimmers": len(swimmers), "times": time_count}
