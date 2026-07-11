# relay-builder

Internal GPSA tool that pools relay-opt-in swimmers from team entry files and
balances them into equal-time free relays with printable deck output (relay
cards, 8-lane heat sheet). Built for the pooled-relay format at the Summer
Splash Invitational — no fixed teams, just swimmers who want to swim a relay.

**Internal only.** Like `publicity-server`/`publicity-intake`, this is a Docker
service run locally in the homelab — it is *not* published to Cloudflare Pages
(the `deploy.yml` allowlist excludes it) and binds to `127.0.0.1` only.

## How it works

```
entry .sd3/.hy3 ──> swimparse CLI (--league gpsa) ──> DOB-free NormalizedMeet JSON
                                                        │
                                                        ▼
                                        SQLite pool (swimmers + free times)
                                                        │
                              scenario (grouping + gender) ──> balance ──> deck output
```

Parsing is delegated entirely to the shared **swimparse** package (`../swimparse`),
the single source of truth for SDIF/HY3. We always pass `--league gpsa`, so the
JSON is **DOB-free** (age groups computed, birthdates stripped) — no minors' PII
is ever stored. Accepts both `.sd3` and `.hy3`; swimparse normalizes them
identically.

## Stack

- FastAPI + Jinja2 + uvicorn
- SQLite (stdlib `sqlite3`, no ORM) on a Docker volume (`/data`)
- Node present only to run the swimparse CLI

## Run locally (no Docker)

```bash
cd relay-builder
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
# -> http://127.0.0.1:8000   (SWIMPARSE_CLI defaults to ../swimparse/cli.js)
```

## Run with Docker

```bash
# local build from source (context = repo root, to include ../swimparse)
docker compose -f docker-compose.local.yml up --build
# or pull the published image
docker compose up -d
```

## Status

- [x] Phase 1 — import (bulk + incremental) → pooled swimmer view
- [x] Phase 2 — scenarios (grouping / gender switches) + snake-draft balancing
- [x] Phase 3 — printable relay cards + 8-lane heat sheet

### Scenarios

A **scenario** is one way to slice the pool into relays: a grouping strategy ×
gender mode. Build several and compare relay counts, alternates, and time spread.

- **Grouping** — `gpsa` (8&U → 100m/4×25, 9-10+ → 200m/4×50), `per-age` (each
  band separate), or `open` (one pool, fixed leg distance).
- **Gender** — `single` (Girls/Boys) or `mixed`.
- **Balancing** — serpentine (snake) draft to equalize 4-swimmer totals, then a
  greedy swap-refinement polish. Seed time matches the leg distance (25 free for
  100m relays, 50 free for 200m).
- **Alternates** — swimmers eligible but unplaced: the remainder past a multiple
  of four, or missing a time at the leg distance (flagged in red).

### Deck output

From a scenario, print-optimized views (site chrome hidden on print):

- **Heat sheet** (`/scenarios/{id}/heatsheet`) — each category's relays seeded
  into 8-lane heats: fastest relays swim last in the centre lanes
  (`4-5-3-6-2-7-1-8`), the first heat is the small/slow one.
- **Relay cards** (`/scenarios/{id}/cards`) — one card per relay with swimmers,
  per-leg times, projected total, and its heat + lane.
