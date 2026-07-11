"""SQLite persistence for the relay builder.

Plain stdlib ``sqlite3`` — no ORM. The tool is single-user and local, so a file
on a Docker volume is all the state we need. A fresh connection per call keeps
things simple and thread-safe under FastAPI's default threadpool.

Phase 1 schema: the imported swimmer pool and their free times. Scenarios and
relays (Phase 2) will layer on top without touching these tables.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

DB_PATH = os.environ.get("RELAY_DB") or str(Path(__file__).resolve().parent.parent / "data" / "relay.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS imports (
    id          INTEGER PRIMARY KEY,
    filename    TEXT NOT NULL,
    fmt         TEXT,
    team        TEXT,
    swimmers    INTEGER DEFAULT 0,
    imported_at TEXT DEFAULT (datetime('now'))
);

-- One row per swimmer. id is swimparse's DOB-free identity: "last|first|agegroup".
CREATE TABLE IF NOT EXISTS swimmers (
    id         TEXT PRIMARY KEY,
    full_name  TEXT NOT NULL,
    last_name  TEXT,
    first_name TEXT,
    gender     TEXT,          -- 'M' | 'F'
    age_group  TEXT,          -- '6&U', '7-8', ...
    team       TEXT
);

-- A swimmer's individual free times, used to seed relay legs. Keyed by
-- (swimmer, distance, stroke) so a re-import overwrites rather than duplicates.
CREATE TABLE IF NOT EXISTS times (
    swimmer_id TEXT NOT NULL REFERENCES swimmers(id) ON DELETE CASCADE,
    distance   INTEGER NOT NULL,
    stroke     TEXT NOT NULL,
    seconds    REAL NOT NULL,
    PRIMARY KEY (swimmer_id, distance, stroke)
);

-- A scenario is one way of slicing the pool into relays: a grouping strategy +
-- gender mode. The pool is stable; scenarios are cheap and disposable, so you
-- can keep several side by side and compare.
CREATE TABLE IF NOT EXISTS scenarios (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    grouping    TEXT NOT NULL,   -- 'gpsa' | 'per-age' | 'open'
    gender_mode TEXT NOT NULL,   -- 'single' | 'mixed'
    open_leg    INTEGER,         -- leg distance (25|50) for 'open' grouping; else NULL
    swimups     INTEGER NOT NULL DEFAULT 1,  -- allow younger swimmers up into older medley legs
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relays (
    id            INTEGER PRIMARY KEY,
    scenario_id   INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    category      TEXT NOT NULL,     -- e.g. "Girls 8 & Under"
    leg_distance  INTEGER NOT NULL,  -- 25 | 50
    idx           INTEGER NOT NULL,  -- relay number within the category (1-based)
    total_seconds REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_legs (
    relay_id   INTEGER NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
    leg_order  INTEGER NOT NULL,     -- 1..4
    swimmer_id TEXT NOT NULL REFERENCES swimmers(id),
    seconds    REAL NOT NULL,
    PRIMARY KEY (relay_id, leg_order)
);

-- Swimmers eligible for a category but not placed in a relay: either the
-- remainder past a multiple of four, or missing a time at the leg distance.
CREATE TABLE IF NOT EXISTS relay_alternates (
    id           INTEGER PRIMARY KEY,
    scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    category     TEXT NOT NULL,
    leg_distance INTEGER NOT NULL,   -- the category's leg distance (25 | 50)
    swimmer_id   TEXT NOT NULL REFERENCES swimmers(id),
    seconds      REAL,               -- leg time if they have one, else NULL
    reason       TEXT NOT NULL       -- 'remainder' | 'no-time'
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(_SCHEMA)
        # Migrate DBs created before the swimups column existed.
        cols = [r[1] for r in conn.execute("PRAGMA table_info(scenarios)").fetchall()]
        if "swimups" not in cols:
            conn.execute("ALTER TABLE scenarios ADD COLUMN swimups INTEGER NOT NULL DEFAULT 1")


def reset() -> None:
    # Drop scenarios first: relay_legs reference swimmers, so swimmers can't be
    # deleted while scenarios exist. Cascades clear relays/legs/alternates.
    with connect() as conn:
        conn.executescript(
            "DELETE FROM scenarios;"
            "DELETE FROM times;"
            "DELETE FROM swimmers;"
            "DELETE FROM imports;"
        )
