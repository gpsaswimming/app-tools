# GPSA Tools

Browser-based tools and API server for GPSA meet management, served at `tools.gpsaswimming.org`.

## Tools

- **[Meet Publicity Tool](publicity.html)** — Processes SDIF files and generates formatted HTML meet results. Supports forfeit/override.
- **[Roster Formatter](roster.html)** — Processes SwimTopia CSV exports into roster, contacts, and officials HTML.

## Publicity API Server

The `publicity-server/` directory contains an Express REST API for automated processing via n8n. See [`publicity-server/README.md`](publicity-server/README.md) for setup and usage.

## Shared Library

`lib/publicity-core.js` contains the shared SDIF parsing logic used by both `publicity.html` (browser) and `publicity-server/server.mjs` (Node.js). Changes here affect both consumers.
