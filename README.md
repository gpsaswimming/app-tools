# GPSA Tools

Browser-based tools and API server for GPSA meet management, served at `tools.gpsaswimming.org`.

## Tools

- **[Meet Publicity Tool](publicity.html)** — Processes SDIF files and generates formatted HTML meet results. Supports forfeit/override.
- **[Roster Formatter](roster.html)** — Processes SwimTopia CSV exports into roster, contacts, and officials HTML.
- **[Invitational Entry Summary](entry-summary.html)** — Calculates Summer Splash / City Meet entry fees from a team's SDIF entry file (`.sd3` or `.zip`) and generates a printable, emailable summary. Parses entirely in the browser (no upload; birthdates stripped).

## Utilities

- **[Time Drops Meters → Yards Converter](timedrops-yards/)** — PowerShell script that rewrites a Time Drops `meet_details.json` so records, time-standard cuts, and entry/seed times are expressed in yards instead of the meters that come over from our SC-Meters SwimTopia config. Keeps the tablet's time-drop and record/cut math correct on a yard pool. See [`timedrops-yards/README.md`](timedrops-yards/README.md).

## Publicity API Server

The `publicity-server/` directory contains an Express REST API for automated processing via n8n. See [`publicity-server/README.md`](publicity-server/README.md) for setup and usage.

## Shared Library

`lib/publicity-core.js` contains the shared SDIF parsing logic used by both `publicity.html` (browser) and `publicity-server/server.mjs` (Node.js). Changes here affect both consumers.

`lib/entry-summary-core.js` holds the fee schedules and billing logic for the Entry Summary tool; it parses via the [`swimparse`](swimparse/) module (vendored into the deployed site from `swimparse/src`). `lib/entry-summary-core.test.js` is a golden test pinning the billing contract (`node --test lib/entry-summary-core.test.js`).
