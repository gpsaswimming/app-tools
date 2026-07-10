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
GPSA_CATEGORIES = [
    ("8 & Under", frozenset({"6&U", "7-8"}), 25),
    ("9-10", frozenset({"9-10"}), 50),
    ("11-12", frozenset({"11-12"}), 50),
    ("13-14", frozenset({"13-14"}), 50),
    ("15-18", frozenset({"15-18"}), 50),
]

PER_AGE_CATEGORIES = [
    ("6 & Under", frozenset({"6&U"}), 25),
    ("7-8", frozenset({"7-8"}), 25),
    ("9-10", frozenset({"9-10"}), 50),
    ("11-12", frozenset({"11-12"}), 50),
    ("13-14", frozenset({"13-14"}), 50),
    ("15-18", frozenset({"15-18"}), 50),
]

ALL_AGE_GROUPS = frozenset({"6&U", "7-8", "9-10", "11-12", "13-14", "15-18"})

RELAY_SIZE = 4


def resolve_categories(grouping: str, gender_mode: str, open_leg: int | None):
    """Expand a scenario config into concrete categories.

    Each category is a dict: label, age_groups, gender ('M'|'F'|None), leg.
    """
    if grouping == "gpsa":
        base = GPSA_CATEGORIES
    elif grouping == "per-age":
        base = PER_AGE_CATEGORIES
    elif grouping == "open":
        base = [("Open", ALL_AGE_GROUPS, open_leg or 50)]
    else:
        raise ValueError(f"unknown grouping: {grouping}")

    genders = [("Girls", "F"), ("Boys", "M")] if gender_mode == "single" else [("", None)]

    categories = []
    for label, ages, leg in base:
        for gprefix, gcode in genders:
            categories.append(
                {
                    "label": f"{gprefix} {label}".strip(),
                    "age_groups": ages,
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
    """Full pipeline for one category's seeded swimmers → (relays, remainder)."""
    relays, remainder = snake_draft(sorted(seeded, key=lambda x: x[1]))
    return refine(relays), remainder


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
