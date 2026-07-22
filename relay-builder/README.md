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
identically. Swimmers can also be **added by hand** for opt-ins who aren't in any
entry file (see [Swimmer pool](#swimmer-pool)).

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

### Swimmer pool

The pool (`/`) is the stable base every scenario is built from. Two ways in:

- **Import** — drop each team's `.sd3`/`.hy3` (or a `.zip` of several); re-importing
  a team updates it in place. Bulk or one team at a time.
- **Add manually** — for a relay opt-in missing from every entry file. Enter name,
  gender, age group, team, and optional **25 / 50 Free** times (`ss.ss`, `ss`, or
  `m:ss.ss`). A manual add builds the same DOB-free `last|first|agegroup` id
  swimparse uses, so a later import of that swimmer merges onto the same row rather
  than duplicating. Leave both times blank and the swimmer still pools — they just
  land in the alternates until given a time.

Manually-added swimmers carry a **`manual`** badge and a remove (`×`) button;
removing one deletes them everywhere and re-totals any relay they'd been seeded
into (re-balance afterward to re-form clean relays). Imported swimmers have no
remove button — clear them with **Reset pool** or a corrected re-import.

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
  per-leg times, projected total, and its event + heat + lane. Printed **four to
  a page in landscape** (2×2 grid, page-breaks every four).
- **Team reports** (`/scenarios/{id}/team-reports`) — one page per team listing
  that team's relay swimmers with the event, heat, and lane they swim in, so a
  pooled relay's swimmers can be handed back to their home teams.
- **Session timeline** (`/scenarios/{id}/timeline`) — estimated clock start time
  for each event, in program order, for posting on deck. A heat runs all lanes at
  once, so it's timed from the **slowest seeded relay in that heat** plus a
  **between-heats gap** (clear the pool + get the next heat set); an event's block
  is the sum of its heats. Timing the heats off real seed times captures what a
  fixed per-race estimate can't — a slow 9-10 heat vs a fast 13-14 heat, and the
  slow early heats vs the fast late ones. Seeded totals are flat-start free times
  summed, so they run a touch long versus actual relay splits — conservative
  (ready early), which is the safe direction. Start time and gap (defaults 9:00 AM
  / 40s) are adjustable on the page and live in the URL, so a tuned timeline is
  bookmarkable and printable. Footer shows estimated finish and total session length.

Categories are numbered as **events** in program order; the same event numbers
appear on the heat sheet, cards, team reports, and timeline so they cross-reference.

### Deck scratches

On meet day, the **Deck** view (`/scenarios/{id}/deck`) handles no-shows live.
Scratching a swimmer records them as out and **patches their relay in place**:
the closest-time eligible **alternate** (one with an entry time; for a medley,
one legal for that leg's age band — its own band or a younger swim-up) is subbed
into the empty leg. Only that one relay changes, so every other already-printed
card stays valid. If no eligible alternate is available the relay is left short
(flagged). The scratch set is the source of truth for who's out, so the
**Re-run balancing** button re-forms all relays around the swimmers still in.
Reprint the heat sheet / cards afterward.
