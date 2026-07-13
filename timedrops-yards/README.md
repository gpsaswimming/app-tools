# Time Drops — Meters → Yards Converter

`Convert-MeetTimesToYards.ps1` rewrites a Time Drops `meet_details.json` meet program so its imported times are expressed in **yards** instead of **meters**.

## Why this exists

GPSA runs its SwimTopia league in **Short Course Meters**, so every meet program that comes over to the Time Drops tablet carries meter times: the record book, the time-standard cuts, and each swimmer's entry (seed) time. Our pools are **25 yards**, so the clock times swimmers actually post are yard times.

That mismatch breaks two things on the tablet:

- **Time drops** — Time Drops computes improvement as `seed − final`. A meter seed time is ~9% slower than the equivalent yard time, so comparing a meter seed against a yard final invents a fake ~9% improvement for everyone.
- **Records & cuts** — a yard swim compared against a meter record or City-qualifying cut is apples-to-oranges; the flags fire (or don't) incorrectly.

This script converts the three meter fields in the meet program down to yards so everything is on the same footing as the actual swims. The swum **final/result times** are never touched — the tablet already records those in yards.

## What it converts

| JSON field | Meaning | Count (typical dual) |
| --- | --- | --- |
| `meetEvents[].eventRecords[].recordTimeInt` | Record book (pool + team records) | ~160 |
| `meetEvents[].eventStandards[].standards[].cut` | Time standards (e.g. City qualifying cuts) | ~50 |
| `meetSessions[].sessionRaces[].raceLanes[].laneSeedTime` | Entry / seed times | ~230 |

All three are integer hundredths of a second (e.g. `11100` = 1:51.00). Conversion is `yards = round(meters / 1.09)`; the `1.09` matches the factor the meet software uses and is overridable with `-Factor`.

## Usage

Requires [PowerShell 7+](https://learn.microsoft.com/powershell/) (`pwsh`), cross-platform.

```powershell
./Convert-MeetTimesToYards.ps1 -Path "2026-06-29 Glendale at Wendwood/meet_details.json"
```

The script:

1. **Backs up** the original to `meet_details.bak` (same folder).
2. Converts the three fields above from meters to yards.
3. **Overwrites `meet_details.json` in place** — this is the filename the tablet imports.
4. Prints per-field counts and a 15-row sample table so you can eyeball the result.

Load the rewritten `meet_details.json` onto the tablet.

### Parameters

| Parameter | Default | Purpose |
| --- | --- | --- |
| `-Path` | `./meet_details.json` | Path to the meet program to convert. |
| `-Factor` | `1.09` | Meters-per-yard factor (`yards = meters / factor`). |
| `-Force` | off | Allow the run even if a `.bak` already exists (see below). |

### Double-conversion guard

If `meet_details.bak` already exists, the script assumes the current `meet_details.json` was already converted and **stops** — running twice would divide by 1.09 a second time and corrupt every time. Delete or rename the stale `.bak` (or pass `-Force`) only if you are certain the current file is still in meters.

## After the meet

If you re-export results **back** to SwimTopia, that meters-configured system expects meter times again. Export from a copy that has *not* been converted, or convert the results back up by `× 1.09`.
