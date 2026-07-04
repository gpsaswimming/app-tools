# @gpsa/swimparse

One parser for GPSA swim-meet results. Reads **SDIF v3** (`.sd3`) and **Hy-Tek**
(`.hy3`) and produces a single `NormalizedMeet` shape, so every GPSA tool consumes
one JSON contract instead of re-implementing fixed-width parsing.

- **Zero dependencies.** Plain ESM — runs in the browser, Node, and CI unchanged.
- **Lossless.** Keeps every swim (placing or not, exhibition, DQ, no-show) plus
  birthdates, seed times, relay legs, splits and DQ reasons. Consumers filter down.
- **Format-agnostic output.** SDIF and HY3 of the same meet parse to the same result.

## Usage

```js
import { parse, detectFormat, score, GPSA } from '@gpsa/swimparse';

const meet = parse(fileText, { filename: 'GG_at_WW.hy3' }); // auto-detects format
const totals = score(meet);                                  // { GG: 320, WW: 146 }

// With a league profile: adds census age-groups and strips birthdates.
const safe = parse(fileText, { league: GPSA });         // DOB-free output
```

CLI:

```bash
swimparse meet.hy3 --pretty              # NormalizedMeet JSON to stdout
swimparse a.sd3 b.hy3 -d out/            # one <name>.json per input
swimparse meet.hy3 --league gpsa         # DOB-free + census age-groups
swimparse meet.hy3 --league-file x.json  # custom league profile
```

## League profiles

A **league profile** is a plain object carrying what a league defines for itself:
its age-up reference date, its age-group bands, and its scoring point values. The
built-in `GPSA` lives in [`src/league.js`](src/league.js); a portable copy is
[`leagues/gpsa.json`](leagues/gpsa.json) (kept equal by a test, and the shape
app-census's editable YAML will mirror).

```js
{
  id: 'gpsa',
  ageUp: { reference: '06-01' },          // age "as of" June 1 of the meet season year
  ageGroups: [ { label: '6&U', max: 6 }, { label: '7-8', min: 7, max: 8 }, /* … */ ],
  scoring: { individualPlaces: [5, 3, 1], relayPlaces: [7], entriesScoredPerTeam: 2 },
}
```

Passing a profile to `parse()` makes the **parse boundary a PII firewall**: swimparse
computes each swimmer's `ageGroup` from their birthdate, then **removes `birthDate`
and `usasId`** from the output and stamps `meet.ageProfile`. That output is DOB-free
and no longer confidential. Without a profile the parse is the raw, lossless
(DOB-bearing) artifact — see Privacy below.

Point *values* come from the profile's `scoring` block; the *structural* rules
(single-gender numbered relays only; mixed 8 & Under "B" relays score 0) stay in the
engine as policy.

## The NormalizedMeet contract

`{ format, source, meet, teams, swimmers, events }` — see [`src/model.js`](src/model.js)
for the full typedefs. Highlights:

- **Times** always carry both `{ text: "1:11.35", seconds: 71.35 }`.
- **Dates** are ISO `YYYY-MM-DD`.
- **`result.status`** is `ok | dq | ns | dnf | scratch | exhibition`; only `ok`
  swims score.

### Format differences worth knowing

| | SDIF (`.sd3`) | Hy-Tek (`.hy3`) |
|---|---|---|
| DQ time | nulled | **retained** (`finalTime` kept) |
| DQ reason | — | **`dqReason`** (e.g. "Arms: Underwater recovery") |
| Points | stored | absent — use `score()` |
| Names | 28-char field | wider, less truncation |

`score()` reproduces SwimTopia's stored SDIF points exactly and gives the HY3 file
the same team totals, so both formats score through one code path. GPSA rules:
individual 5-3-1-0, relay winner 7 (single-gender numbered relays only; mixed
8 & Under "B" relays don't score).

## Privacy

`swimmers[].birthDate` / `usasId` are PII for minors — a `NormalizedMeet` parsed
**without** a league profile carries them and is a confidential artifact. Do not
publish raw parser output publicly without sanitizing. Parsing **with** a league
profile strips those fields (see [League profiles](#league-profiles)) and is safe
to publish. Test fixtures use public figures with shifted birth years; see
[`test/fixtures/README.md`](test/fixtures/README.md).

## Tests

```bash
node --test    # golden snapshots + SDIF↔HY3 cross-agreement + scoring
```
