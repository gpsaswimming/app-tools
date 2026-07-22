"""GPSA Relay Builder — internal FastAPI service.

Pools relay-opt-in swimmers across teams from their entry files and (Phase 2+)
balances them into equal-time free relays with printable deck output.

Phase 1: import entry files (bulk or one at a time) and view the pooled roster.
"""

from __future__ import annotations

import io
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Form, Request, UploadFile
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import db, scenarios
from .ingest import ingest_meet
from .swimparse import SwimparseError, parse_meet

BASE = Path(__file__).resolve().parent
app = FastAPI(title="GPSA Relay Builder")
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")

# GPSA age-group order for the pool view.
AGE_ORDER = ["6&U", "7-8", "9-10", "11-12", "13-14", "15-18"]

# Canonical GPSA team codes, for the manual-add datalist (free text still allowed
# so a pooled invitational relay with a guest team isn't blocked).
TEAM_CODES = [
    "BLMAR", "COL", "CV", "EL", "GG", "HW", "JRCC", "KCD", "MBKMT", "NHM",
    "POQ", "RMMR", "RRST", "VG", "WO", "WPPIR", "WW", "WYCC", "WYTH",
]
GENDERS = {"F", "M"}

GROUPING_LABELS = {"gpsa": "GPSA standard", "per-age": "Per age group", "open": "Open pool"}
GENDER_LABELS = {"single": "single-gender", "mixed": "mixed"}


def _mmss(seconds):
    """Seconds → m:ss.ss (or ss.ss under a minute) for display."""
    if seconds is None:
        return "—"
    minutes = int(seconds // 60)
    rem = seconds - minutes * 60
    return f"{minutes}:{rem:05.2f}" if minutes else f"{rem:.2f}"


def _clock(seconds):
    """Seconds since midnight → 'h:mm AM/PM' for the session timeline."""
    if seconds is None:
        return "—"
    total = int(round(seconds))
    hour24 = (total // 3600) % 24
    minute = (total % 3600) // 60
    period = "AM" if hour24 < 12 else "PM"
    hour12 = hour24 % 12 or 12
    return f"{hour12}:{minute:02d} {period}"


templates.env.filters["mmss"] = _mmss
templates.env.filters["clock"] = _clock
templates.env.globals["GROUPING_LABELS"] = GROUPING_LABELS


def _parse_seconds(raw: str):
    """Parse an entry time — 'ss.ss', 'ss', or 'm:ss.ss' — to float seconds.

    Blank → None (swimmer added without that time). Raises ValueError on garbage.
    """
    raw = (raw or "").strip()
    if not raw:
        return None
    if ":" in raw:
        mins, secs = raw.split(":", 1)
        value = int(mins) * 60 + float(secs)
    else:
        value = float(raw)
    if value <= 0:
        raise ValueError("time must be positive")
    return value


def _parse_clock(raw: str, default: int = 9 * 3600) -> int:
    """'HH:MM' (24h, from an <input type=time>) → seconds since midnight."""
    try:
        hours, minutes = raw.split(":")
        return int(hours) * 3600 + int(minutes) * 60
    except (ValueError, AttributeError):
        return default


def _default_scenario_name(grouping: str, gender_mode: str) -> str:
    return f"{GROUPING_LABELS.get(grouping, grouping)} · {GENDER_LABELS.get(gender_mode, gender_mode)}"


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/")
def pool(request: Request, added: str = "", err: str = ""):
    with db.connect() as conn:
        swimmers = conn.execute(
            """
            SELECT s.*,
                   (SELECT seconds FROM times t WHERE t.swimmer_id = s.id AND t.distance = 25 AND t.stroke = 'Freestyle') AS free25,
                   (SELECT seconds FROM times t WHERE t.swimmer_id = s.id AND t.distance = 50 AND t.stroke = 'Freestyle') AS free50
            FROM swimmers s
            """
        ).fetchall()
        imports = conn.execute(
            "SELECT * FROM imports ORDER BY imported_at DESC, id DESC"
        ).fetchall()

    # Group by age group (GPSA order) then gender for the roster view.
    groups: dict[str, dict[str, list]] = {}
    for s in swimmers:
        ag = s["age_group"] or "?"
        groups.setdefault(ag, {"F": [], "M": []}).setdefault(s["gender"] or "?", []).append(s)
    ordered = sorted(groups.items(), key=lambda kv: (AGE_ORDER.index(kv[0]) if kv[0] in AGE_ORDER else 99, kv[0]))

    return templates.TemplateResponse(
        request=request,
        name="pool.html",
        context={
            "groups": ordered,
            "imports": imports,
            "total": len(swimmers),
            "team_codes": TEAM_CODES,
            "age_groups": AGE_ORDER,
            "added": added,
            "err": err,
        },
    )


ENTRY_EXTS = (".sd3", ".hy3")


def _entry_files(filename: str, data: bytes):
    """Yield (name, bytes) for each parseable entry file in an upload.

    A .zip is expanded to its .sd3/.hy3 members (Meet Maestro often exports a
    zip); a plain entry file yields itself.
    """
    name = (filename or "").lower()
    if name.endswith(".zip"):
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            return
        for info in zf.infolist():
            if info.is_dir() or not info.filename.lower().endswith(ENTRY_EXTS):
                continue
            yield info.filename, zf.read(info)
    elif name.endswith(ENTRY_EXTS):
        yield filename, data


@app.post("/import")
async def import_files(files: list[UploadFile]):
    """Accept one or many .sd3/.hy3/.zip uploads; parse + upsert each entry file."""
    imported: list[dict] = []
    with db.connect() as conn:
        for upload in files:
            data = await upload.read()
            if not data:
                continue
            for member_name, member_bytes in _entry_files(upload.filename or "", data):
                suffix = Path(member_name).suffix or ".sd3"
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
                    tmp.write(member_bytes)
                    tmp.flush()
                    try:
                        meet = parse_meet(tmp.name)
                    except SwimparseError as exc:
                        imported.append({"file": member_name, "error": str(exc) or "parse failed"})
                        continue
                summary = ingest_meet(conn, meet, filename=member_name)
                imported.append({"file": member_name, **summary})
        conn.commit()
    return {"success": True, "imported": imported}


@app.post("/reset")
def reset():
    db.reset()
    return {"success": True}


@app.post("/swimmers")
def add_swimmer(
    first_name: str = Form(...),
    last_name: str = Form(...),
    gender: str = Form(...),
    age_group: str = Form(...),
    team: str = Form(...),
    free25: str = Form(""),
    free50: str = Form(""),
):
    """Manually add one swimmer to the pool — for opt-ins missing from an entry
    file. Builds the same DOB-free ``last|first|agegroup`` id swimparse uses, so a
    later import of the same swimmer updates this row in place rather than duplicating.
    """
    first, last = first_name.strip(), last_name.strip()
    team, gender = team.strip().upper(), gender.strip().upper()
    if not first or not last or gender not in GENDERS or age_group not in AGE_ORDER or not team:
        return RedirectResponse(url="/?err=" + quote("Missing or invalid swimmer details."), status_code=303)
    try:
        times = {25: _parse_seconds(free25), 50: _parse_seconds(free50)}
    except ValueError:
        return RedirectResponse(
            url="/?err=" + quote("Enter times as seconds (e.g. 31.45) or m:ss.ss."), status_code=303
        )

    sid = f"{last}|{first}|{age_group}".lower()
    full_name = f"{last}, {first}"
    with db.connect() as conn:
        conn.execute(
            """
            INSERT INTO swimmers (id, full_name, last_name, first_name, gender, age_group, team, source)
            VALUES (?,?,?,?,?,?,?,'manual')
            ON CONFLICT(id) DO UPDATE SET
                full_name = excluded.full_name, last_name = excluded.last_name,
                first_name = excluded.first_name, gender = excluded.gender,
                age_group = excluded.age_group, team = excluded.team
            """,
            (sid, full_name, last, first, gender, age_group, team),
        )
        for distance, secs in times.items():
            if secs is not None:
                conn.execute(
                    "INSERT INTO times (swimmer_id, distance, stroke, seconds) VALUES (?,?,'Freestyle',?)"
                    " ON CONFLICT(swimmer_id, distance, stroke) DO UPDATE SET seconds = excluded.seconds",
                    (sid, distance, secs),
                )
        conn.commit()
    return RedirectResponse(url="/?added=" + quote(full_name), status_code=303)


@app.post("/swimmers/delete")
def delete_swimmer(swimmer_id: str = Form(...)):
    with db.connect() as conn:
        db.remove_swimmer(conn, swimmer_id)
        conn.commit()
    return RedirectResponse(url="/", status_code=303)


@app.get("/scenarios")
def scenarios_list(request: Request):
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM scenarios ORDER BY id DESC").fetchall()
        cards = [{**dict(r), **scenarios.summary(conn, r["id"])} for r in rows]
        pool_total = conn.execute("SELECT COUNT(*) FROM swimmers").fetchone()[0]
    return templates.TemplateResponse(
        request=request, name="scenarios.html", context={"scenarios": cards, "pool_total": pool_total}
    )


@app.post("/scenarios")
def scenario_create(
    grouping: str = Form(...),
    gender_mode: str = Form(...),
    open_leg: int = Form(50),
    swimups: str = Form("on"),
    name: str = Form(""),
):
    name = name.strip() or _default_scenario_name(grouping, gender_mode)
    open_leg_val = open_leg if grouping == "open" else None
    swim = 1 if swimups == "on" else 0
    with db.connect() as conn:
        sid = conn.execute(
            "INSERT INTO scenarios (name, grouping, gender_mode, open_leg, swimups) VALUES (?,?,?,?,?)",
            (name, grouping, gender_mode, open_leg_val, swim),
        ).lastrowid
        scenarios.build(conn, sid, grouping, gender_mode, open_leg_val, bool(swim))
        conn.commit()
    return RedirectResponse(url=f"/scenarios/{sid}", status_code=303)


@app.get("/scenarios/{scenario_id}")
def scenario_detail(request: Request, scenario_id: int):
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if not sc:
            return RedirectResponse(url="/scenarios", status_code=303)
        categories = scenarios.detail(conn, scenario_id)
    return templates.TemplateResponse(
        request=request, name="scenario.html", context={"sc": sc, "categories": categories}
    )


POOL_LANES = 8


@app.get("/scenarios/{scenario_id}/heatsheet")
def scenario_heatsheet(request: Request, scenario_id: int):
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if not sc:
            return RedirectResponse(url="/scenarios", status_code=303)
        plan, _ = scenarios.heat_plan(conn, scenario_id, lanes=POOL_LANES)
    # Expand each heat to a full lane list (1..8), empties as None — like a meet sheet.
    for cat in plan:
        for heat in cat["heats"]:
            by_lane = {slot["lane"]: slot["relay"] for slot in heat["lanes"]}
            heat["rows"] = [(lane, by_lane.get(lane)) for lane in range(1, POOL_LANES + 1)]
    printed = datetime.now().strftime("%m/%d/%y %I:%M %p")
    return templates.TemplateResponse(
        request=request,
        name="heatsheet.html",
        context={"sc": sc, "plan": plan, "printed": printed, "lanes": POOL_LANES},
    )


@app.get("/scenarios/{scenario_id}/cards")
def scenario_cards(request: Request, scenario_id: int):
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if not sc:
            return RedirectResponse(url="/scenarios", status_code=303)
        _, cards = scenarios.heat_plan(conn, scenario_id)
    return templates.TemplateResponse(request=request, name="cards.html", context={"sc": sc, "cards": cards})


@app.get("/scenarios/{scenario_id}/team-reports")
def scenario_team_reports(request: Request, scenario_id: int):
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if not sc:
            return RedirectResponse(url="/scenarios", status_code=303)
        teams = scenarios.team_reports(conn, scenario_id, lanes=POOL_LANES)
    printed = datetime.now().strftime("%m/%d/%y %I:%M %p")
    return templates.TemplateResponse(
        request=request, name="team_reports.html", context={"sc": sc, "teams": teams, "printed": printed}
    )


# Session-timeline defaults: the meet start clock and the between-heats gap
# (seconds) to clear the pool and get the next heat set. Heat length itself comes
# from each heat's slowest seeded relay, so there's nothing to estimate per race.
TL_DEFAULTS = {"gap": 40, "start": "09:00"}


@app.get("/scenarios/{scenario_id}/timeline")
def scenario_timeline(
    request: Request,
    scenario_id: int,
    start: str = TL_DEFAULTS["start"],
    gap: int = TL_DEFAULTS["gap"],
):
    gap = max(0, gap)
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if not sc:
            return RedirectResponse(url="/scenarios", status_code=303)
        tl = scenarios.timeline(conn, scenario_id, start_seconds=_parse_clock(start), gap=gap, lanes=POOL_LANES)
    printed = datetime.now().strftime("%m/%d/%y %I:%M %p")
    return templates.TemplateResponse(
        request=request,
        name="timeline.html",
        context={"sc": sc, "tl": tl, "printed": printed, "params": {"start": start, "gap": gap}},
    )


@app.get("/scenarios/{scenario_id}/deck")
def scenario_deck(request: Request, scenario_id: int):
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if not sc:
            return RedirectResponse(url="/scenarios", status_code=303)
        categories = scenarios.detail(conn, scenario_id)
        scratched = scenarios.list_scratches(conn, scenario_id)
    return templates.TemplateResponse(
        request=request,
        name="deck.html",
        context={"sc": sc, "categories": categories, "scratched": scratched},
    )


@app.post("/scenarios/{scenario_id}/scratch")
def scenario_scratch(scenario_id: int, swimmer_id: str = Form(...)):
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if sc:
            scenarios.scratch(
                conn, scenario_id, swimmer_id,
                sc["grouping"], sc["gender_mode"], sc["open_leg"], bool(sc["swimups"]),
            )
            conn.commit()
    return RedirectResponse(url=f"/scenarios/{scenario_id}/deck", status_code=303)


@app.post("/scenarios/{scenario_id}/unscratch")
def scenario_unscratch(scenario_id: int, swimmer_id: str = Form(...)):
    with db.connect() as conn:
        scenarios.unscratch(conn, scenario_id, swimmer_id)
        conn.commit()
    return RedirectResponse(url=f"/scenarios/{scenario_id}/deck", status_code=303)


@app.post("/scenarios/{scenario_id}/rebalance")
def scenario_rebalance(scenario_id: int, redirect: str = Form("detail")):
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if sc:
            scenarios.build(conn, scenario_id, sc["grouping"], sc["gender_mode"], sc["open_leg"], bool(sc["swimups"]))
            conn.commit()
    dest = f"/scenarios/{scenario_id}/deck" if redirect == "deck" else f"/scenarios/{scenario_id}"
    return RedirectResponse(url=f"{dest}", status_code=303)


@app.post("/scenarios/{scenario_id}/clone")
def scenario_clone(scenario_id: int):
    with db.connect() as conn:
        sc = conn.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if not sc:
            return RedirectResponse(url="/scenarios", status_code=303)
        sid = conn.execute(
            "INSERT INTO scenarios (name, grouping, gender_mode, open_leg, swimups) VALUES (?,?,?,?,?)",
            (f"{sc['name']} (copy)", sc["grouping"], sc["gender_mode"], sc["open_leg"], sc["swimups"]),
        ).lastrowid
        scenarios.build(conn, sid, sc["grouping"], sc["gender_mode"], sc["open_leg"], bool(sc["swimups"]))
        conn.commit()
    return RedirectResponse(url=f"/scenarios/{sid}", status_code=303)


@app.post("/scenarios/{scenario_id}/delete")
def scenario_delete(scenario_id: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM scenarios WHERE id = ?", (scenario_id,))
        conn.commit()
    return RedirectResponse(url="/scenarios", status_code=303)
