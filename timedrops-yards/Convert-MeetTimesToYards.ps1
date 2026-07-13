#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Convert meter times in a Time-Drops meet_details.json to yard times.

.DESCRIPTION
    The league is configured in SwimTopia as Short Course Meters, so the record
    book and time-standard cuts come over in the meet program as METER times.
    The pool is 25 yards, so swimmers' actual clock times are YARD times, and
    comparing a yard swim against a meter record/standard is apples-to-oranges.

    This script divides every record time (recordTimeInt) and standard cut (cut)
    by the conversion factor (default 1.09) to express them in yards, so they
    line up with the real yard swims. Swum result times are NOT touched.

    Times in the file are stored as integer hundredths of a second
    (e.g. 11100 = 1:51.00); the script keeps that format.

.PARAMETER Path
    Path to meet_details.json. Defaults to ./meet_details.json.

.PARAMETER Factor
    Meters-per-yard conversion factor. Default 1.09 (yards = meters / factor).

.PARAMETER OutPath
    Where to write the converted file. Defaults to <name>.yards.json next to the input.

.PARAMETER InPlace
    Overwrite the input file instead of writing a copy.

.EXAMPLE
    ./Convert-MeetTimesToYards.ps1 -Path "2026-06-29 Glendale at Wendwood/meet_details.json"
#>
[CmdletBinding()]
param(
    [string]$Path = "./meet_details.json",
    [double]$Factor = 1.09,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    throw "File not found: $Path"
}

# Back up alongside the original: meet_details.json -> meet_details.bak
$backup = [System.IO.Path]::ChangeExtension($Path, '.bak')

# Guard against running twice: a stale .bak would mean the "original" is
# already converted, and dividing by 1.09 again would corrupt the times.
if ((Test-Path -LiteralPath $backup) -and -not $Force) {
    throw "Backup already exists: $backup`nThis file looks already converted. Re-run with -Force only if you are sure the current meet_details.json is still in meters."
}

$meet = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json

# hundredths (int) -> m:ss.hh for the change log
function Format-Time([int]$cs) {
    $total = $cs / 100.0
    $m = [math]::Floor($total / 60)
    $s = $total - ($m * 60)
    if ($m -gt 0) { '{0}:{1:00.00}' -f $m, $s } else { '{0:0.00}' -f $s }
}

$changes = [System.Collections.Generic.List[object]]::new()

function Convert-Cs([int]$cs) {
    # meters -> yards, keep integer hundredths
    [int][math]::Round($cs / $Factor)
}

foreach ($ev in $meet.meetEvents) {

    # ---- Record book ----
    foreach ($rec in $ev.eventRecords) {
        if ($null -ne $rec.recordTimeInt -and $rec.recordTimeInt -gt 0) {
            $old = [int]$rec.recordTimeInt
            $new = Convert-Cs $old
            $rec.recordTimeInt = $new
            $changes.Add([pscustomobject]@{
                Event = $ev.eventDescription
                Kind  = "record: $($rec.recordSetName)"
                Meters = Format-Time $old
                Yards  = Format-Time $new
            })
        }
    }

    # ---- Time standards (City cuts, etc.) ----
    foreach ($grp in $ev.eventStandards) {
        foreach ($std in $grp.standards) {
            if ($null -ne $std.cut -and $std.cut -gt 0) {
                $old = [int]$std.cut
                $new = Convert-Cs $old
                $std.cut = $new
                $changes.Add([pscustomobject]@{
                    Event = $ev.eventDescription
                    Kind  = "standard: $($std.label)"
                    Meters = Format-Time $old
                    Yards  = Format-Time $new
                })
            }
        }
    }
}

# ---- Entry / seed times (drive the seed-vs-final time-drop calc) ----
$seedCount = 0
foreach ($sess in $meet.meetSessions) {
    foreach ($race in $sess.sessionRaces) {
        foreach ($lane in $race.raceLanes) {
            if ($null -ne $lane.laneSeedTime -and $lane.laneSeedTime -gt 0) {
                $lane.laneSeedTime = Convert-Cs ([int]$lane.laneSeedTime)
                $seedCount++
            }
        }
    }
}

# Move the original out of the way, then overwrite meet_details.json in place
# (this filename is what the tablet imports).
Move-Item -LiteralPath $Path -Destination $backup -Force
$meet | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding utf8

$recCount = ($changes | Where-Object Kind -like 'record:*').Count
$stdCount = ($changes | Where-Object Kind -like 'standard:*').Count

Write-Host ""
Write-Host "Converted meters -> yards (/$Factor):" -ForegroundColor Green
Write-Host ("  {0,4} record times" -f $recCount)
Write-Host ("  {0,4} standard cuts" -f $stdCount)
Write-Host ("  {0,4} entry/seed times" -f $seedCount)
Write-Host "Original backed up to: $backup" -ForegroundColor Yellow
Write-Host "Rewrote in place:      $Path" -ForegroundColor Green
Write-Host ""
Write-Host "Sample (records + standards):"
$changes | Select-Object -First 15 | Format-Table -AutoSize
