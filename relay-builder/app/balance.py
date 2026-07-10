"""Relay balancing.

Free relays only. Goal: form relays of four whose 4-swimmer time *totals* are as
equal as possible, so every heat is a close race.

Method — a serpentine (snake) draft, then a swap-refinement polish:
  1. Sort a category's swimmers by seed time.
  2. Deal them one-per-relay, snaking direction each leg. This alone gives very
     even totals and is explainable on deck ("we snaked the seed times").
  3. Greedily swap swimmers between the fastest and slowest relays while it
     shrinks the spread (max total − min total).

Which time seeds a swimmer depends on the relay's leg distance: a 100m relay is
four 25s, a 200m relay is four 50s. Callers pass the right per-leg time.
"""

from __future__ import annotations

# Relay categories per grouping strategy: (label, {age groups}, leg distance).
# Leg distance follows GPSA practice — 8&U swims a 100 (4×25), older a 200 (4×50).
ALL_AGE_GROUPS = ("6&U", "7-8", "9-10", "11-12", "13-14", "15-18")
# The GPSA 200m relay is an age-medley: one swimmer from each of these bands,
# each swimming a 50 free leg (4×50 = 200m).
MEDLEY_AGES = ["9-10", "11-12", "13-14", "15-18"]
RELAY_SIZE = 4


def _base_categories(grouping: str, open_leg: int | None):
    """Relay types for a grouping: (label, kind, spec, leg_distance).

    kind 'partition' → spec is the set of eligible age groups; form free relays
                       of any four from that pool, seeded by the leg-distance free.
    kind 'medley'    → spec is the ordered list of age-group legs; each relay
                       takes exactly one swimmer from each band.
    """
    if grouping == "gpsa":
        return [
            ("8 & Under", "partition", frozenset({"6&U", "7-8"}), 25),
            ("9-18", "medley", MEDLEY_AGES, 50),
        ]
    if grouping == "per-age":
        return [
            ("6 & Under", "partition", frozenset({"6&U"}), 25),
            ("7-8", "partition", frozenset({"7-8"}), 25),
            ("9-10", "partition", frozenset({"9-10"}), 50),
            ("11-12", "partition", frozenset({"11-12"}), 50),
            ("13-14", "partition", frozenset({"13-14"}), 50),
            ("15-18", "partition", frozenset({"15-18"}), 50),
        ]
    if grouping == "open":
        return [("Open", "partition", frozenset(ALL_AGE_GROUPS), open_leg or 50)]
    raise ValueError(f"unknown grouping: {grouping}")


def resolve_categories(grouping: str, gender_mode: str, open_leg: int | None):
    """Expand a scenario config into concrete categories.

    Each category is a dict: label, kind ('partition'|'medley'), spec, gender
    ('M'|'F'|None), leg.
    """
    genders = [("Girls", "F"), ("Boys", "M")] if gender_mode == "single" else [("", None)]
    categories = []
    for label, kind, spec, leg in _base_categories(grouping, open_leg):
        for gprefix, gcode in genders:
            categories.append(
                {
                    "label": f"{gprefix} {label}".strip(),
                    "kind": kind,
                    "spec": spec,
                    "gender": gcode,
                    "leg": leg,
                }
            )
    return categories


def snake_draft(seeded: list[tuple[str, float]]):
    """seeded: (swimmer_id, seconds) sorted ascending. Returns (relays, remainder).

    relays is a list of relays, each a list of (swimmer_id, seconds).
    """
    k = len(seeded) // RELAY_SIZE
    if k == 0:
        return [], list(seeded)

    used = seeded[: k * RELAY_SIZE]
    remainder = seeded[k * RELAY_SIZE :]
    relays: list[list[tuple[str, float]]] = [[] for _ in range(k)]
    for leg in range(RELAY_SIZE):
        chunk = used[leg * k : (leg + 1) * k]
        order = range(k) if leg % 2 == 0 else range(k - 1, -1, -1)
        for pos, r in enumerate(order):
            relays[r].append(chunk[pos])
    return relays, remainder


def _total(relay) -> float:
    return sum(sec for _, sec in relay)


def refine(relays, max_passes: int = 500):
    """Shrink the spread of relay totals via greedy hi/lo swaps."""
    if len(relays) < 2:
        return relays
    for _ in range(max_passes):
        totals = [_total(r) for r in relays]
        hi = max(range(len(relays)), key=lambda i: totals[i])
        lo = min(range(len(relays)), key=lambda i: totals[i])
        spread = totals[hi] - totals[lo]
        if spread <= 1e-9:
            break
        best = None  # (new_spread, leg_hi, leg_lo)
        for a in range(RELAY_SIZE):
            for b in range(RELAY_SIZE):
                sa = relays[hi][a][1]
                sb = relays[lo][b][1]
                if sa <= sb:  # only helps to move a slower swimmer off the hi relay
                    continue
                new_hi = totals[hi] - sa + sb
                new_lo = totals[lo] - sb + sa
                new_spread = abs(new_hi - new_lo)
                if new_spread < spread - 1e-9 and (best is None or new_spread < best[0]):
                    best = (new_spread, a, b)
        if best is None:
            break
        _, a, b = best
        relays[hi][a], relays[lo][b] = relays[lo][b], relays[hi][a]
    return relays


def balance_category(seeded: list[tuple[str, float]]):
    """Full pipeline for one partition category's seeded swimmers → (relays, remainder)."""
    relays, remainder = snake_draft(sorted(seeded, key=lambda x: x[1]))
    return refine(relays), remainder


def _balance_columns(relays, ncol, sweeps: int = 40):
    """Equalize relay totals by coordinate descent, one leg column at a time.

    Holding the other legs fixed, a column's totals are minimized-variance when
    its largest time is paired with the relay that has the smallest partial sum
    (rearrangement inequality). Re-pairing each column that way in turn, swept
    until stable, converges fast and keeps one swimmer per column (per age band).
    """
    n = len(relays)
    if n < 2:
        return relays
    for _ in range(sweeps):
        changed = False
        for c in range(ncol):
            base = [_total(relays[i]) - relays[i][c][1] for i in range(n)]  # totals minus this leg
            vals = [relays[i][c] for i in range(n)]
            relays_low_first = sorted(range(n), key=lambda i: base[i])          # smallest partial sum first
            vals_slow_first = sorted(range(n), key=lambda k: vals[k][1], reverse=True)  # slowest time first
            for pos in range(n):
                target = relays_low_first[pos]
                val = vals[vals_slow_first[pos]]
                if relays[target][c] is not val:
                    changed = True
                relays[target][c] = val
        if not changed:
            break
    return relays


def balance_medley(columns: list[list[tuple[str, float]]]):
    """Age-medley relays: one swimmer per age-group column.

    columns: one (swimmer_id, seconds) list per leg/age band. Returns
    (relays, leftovers): each relay is a list of (id, seconds) in column/leg
    order; leftovers is (id, seconds, column_index) for swimmers not placed.

    Relay count is capped by the smallest band; the fastest swimmers of larger
    bands swim, the slowest are alternates. Totals are equalized by per-column
    coordinate descent, which keeps exactly one swimmer per band in each relay.
    """
    cols = [sorted(c, key=lambda x: x[1]) for c in columns]  # each ascending
    ncol = len(cols)
    n = min((len(c) for c in cols), default=0)
    if n == 0:
        leftovers = [(sid, sec, ci) for ci, c in enumerate(cols) for (sid, sec) in c]
        return [], leftovers

    chosen = [c[:n] for c in cols]  # fastest n per band swim
    leftovers = [(sid, sec, ci) for ci, c in enumerate(cols) for (sid, sec) in c[n:]]

    relays = [[chosen[ci][r] for ci in range(ncol)] for r in range(n)]
    _balance_columns(relays, ncol)
    return relays, leftovers


def swimup_columns(bands: list[list[tuple[str, float]]]):
    """Fill age-ordered medley legs allowing swim-ups (younger → older leg).

    bands: one (id, seconds) list per age band, youngest first. Returns
    (columns, leftovers): four equal-length leg columns (youngest leg first) plus
    the swimmers who don't fit. Balancing then draws one per column.

    The youngest leg only ever holds its own age (nobody younger exists to swim
    up); each older leg prefers its own age, then backfills with younger swim-ups.
    Relay count R is the most that can be filled legally — bounded by the supply
    of younger swimmers, since only they can cover the constrained young legs. So
    four 9-10s is a valid relay (one swims 9-10, three swim up).
    """
    bands = [sorted(b, key=lambda x: x[1]) for b in bands]  # fastest first
    sizes = [len(b) for b in bands]
    ncol = len(bands)

    # Max relays: for legs 0..k (which only younger-or-equal swimmers can fill),
    # R*(k+1) must not exceed the supply of swimmers in bands 0..k.
    r = sum(sizes) // ncol
    cum = 0
    for k in range(ncol):
        cum += sizes[k]
        r = min(r, cum // (k + 1))
    if r == 0:
        return [[] for _ in range(ncol)], [(sid, sec, bi) for bi, b in enumerate(bands) for (sid, sec) in b]

    avail = [list(b) for b in bands]
    columns: list[list] = [[] for _ in range(ncol)]
    for leg in range(ncol):
        need = r
        for b in [leg, *range(leg - 1, -1, -1)]:  # own age first, then younger swim-ups
            while need > 0 and avail[b]:
                columns[leg].append(avail[b].pop(0))  # fastest available swims
                need -= 1
            if need == 0:
                break
    leftovers = [(sid, sec, bi) for bi in range(ncol) for (sid, sec) in avail[bi]]
    return columns, leftovers


def center_out(lanes: int) -> list[int]:
    """Lane fill order from the centre outward. 8 lanes → [4,5,3,6,2,7,1,8]."""
    center = (lanes + 1) // 2
    order = [center]
    step = 1
    while len(order) < lanes:
        if center + step <= lanes:
            order.append(center + step)
        if center - step >= 1:
            order.append(center - step)
        step += 1
    return order


def assign_heats(relays: list, lanes: int = 8) -> list[dict]:
    """Seed built relays into heats, standard-meet style.

    Fastest relays swim last, in the centre lanes; the first heat is the small,
    slow one. Each relay dict must carry 'total'. Returns heats numbered from 1
    (slowest) with lane assignments, e.g.
        [{"heat": 1, "lanes": [{"lane": 4, "relay": {...}}, ...]}, ...]
    """
    seeds = sorted(relays, key=lambda r: r["total"])  # fastest first
    k = len(seeds)
    if k == 0:
        return []
    order = center_out(lanes)
    num_heats = (k + lanes - 1) // lanes
    first_size = k - lanes * (num_heats - 1)  # the slow heat 1 takes the remainder

    heats: list[dict] = [None] * num_heats  # type: ignore[list-item]
    pos = 0
    for h in range(num_heats - 1, -1, -1):  # fill the last (fastest) heat first
        size = first_size if h == 0 else lanes
        chunk = seeds[pos : pos + size]
        pos += size
        laned = [{"lane": order[i], "relay": chunk[i]} for i in range(len(chunk))]
        laned.sort(key=lambda slot: slot["lane"])
        heats[h] = {"heat": h + 1, "lanes": laned}
    return heats
