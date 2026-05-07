# CLAUDE.md — app-tools

Guidance for Claude Code when working in this repository.

---

## Repository Overview

Browser-based GPSA tools and the publicity API server, served at `tools.gpsaswimming.org`.

This repo lives at `github.com/gpsaswimming/app-tools`.

---

## Structure

```
/
├── index.html              # Tools landing page (tools.gpsaswimming.org)
├── publicity.html          # SDIF results processor (tools.gpsaswimming.org/publicity.html)
├── roster.html             # Team roster formatter (tools.gpsaswimming.org/roster.html)
├── lib/
│   └── publicity-core.js   # Shared parsing logic (used by publicity.html + server)
└── publicity-server/
    ├── server.mjs          # Express API (REST endpoint for n8n automation)
    ├── package.json
    ├── docker-compose.yml
    └── README.md
```

---

## Key Architecture

### Shared lib
`lib/publicity-core.js` is imported by both:
- `publicity.html` — browser tool (`import ... from './lib/publicity-core.js'`)
- `publicity-server/server.mjs` — Node.js API (Docker mounts `../lib` as `/app/lib`)

Any change to `publicity-core.js` affects both consumers. Test both after changes.

### Cloudflare Pages
The `main` branch deploys to `tools.gpsaswimming.org` via CF Pages project `gpsa-tools`. Only `index.html`, `publicity.html`, `roster.html`, and `lib/` are served as static files. `publicity-server/` is not served by Pages.

### publicity-server (Docker)
The API server runs via Docker Compose on-prem. The `docker-compose.yml` volume mounts:
- `./` → `/app` (server code)
- `../lib` → `/app/lib` (shared module — must be run from `publicity-server/` directory)

n8n drives the primary automation workflow (SD3 → API → publish). `publicity.html` is the manual fallback.

---

## CSS and Branding

All CSS comes from `https://css.gpsaswimming.org/gpsa-tools-common.css` (absolute URL — no local CSS folder in this repo).

Logo: `https://assets.gpsaswimming.org/img/gpsa_logo.png`

Brand colors:
- Navy: `#002366` (primary)
- Red: `#d9242b` (secondary/accent)

---

## What NOT to Do

- Do not add a local `css/` folder — use the absolute URL to `css.gpsaswimming.org`
- Do not add HY3 support to the publicity tool (SDIF only — see monolith DOCUMENTATION.md for rationale)
- Do not add regularly-updated content (meet results) here — that belongs in the `results` repo
- Do not commit `node_modules/` or raw SDIF files (`.sd3`, `.zip`)
