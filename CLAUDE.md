# CLAUDE.md — app-tools

Guidance for Claude Code when working in this repository.

---

## Repository Overview

Browser-based GPSA tools and the publicity API server, served at `tools.gpsaswimming.org`, plus two internal Docker services (`publicity-server`, `publicity-intake`) that are not part of the public site.

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
├── Dockerfile              # Builds the publicity-server image
├── publicity-server/
│   ├── server.mjs          # Express API (REST endpoint for n8n automation)
│   ├── package.json
│   ├── docker-compose.yml
│   └── README.md
└── publicity-intake/       # Internal Pangolin-fronted results submission form
    ├── server.mjs          # Express: serves form + proxies upload to n8n webhook
    ├── public/             # index.html (branded form) + app.js (client logic)
    ├── package.json
    ├── Dockerfile          # Builds the publicity-intake image (context = repo root)
    ├── docker-compose.yml
    ├── .env.example        # N8N_WEBHOOK_URL lives here (never commit .env)
    └── README.md
```

The two Docker services are **internal only** — neither is served by Cloudflare
Pages, and `publicity-intake` sits behind Pangolin for authentication.

---

## Key Architecture

### Shared lib
`lib/publicity-core.js` is imported by both:
- `publicity.html` — browser tool (`import ... from './lib/publicity-core.js'`)
- `publicity-server/server.mjs` — Node.js API (Docker mounts `../lib` as `/app/lib`)

Any change to `publicity-core.js` affects both consumers. Test both after changes.

### Cloudflare Pages
The `main` branch deploys to `tools.gpsaswimming.org` via CF Pages project `gpsa-tools` (workflow: `.github/workflows/deploy.yml`).

The deploy stages an **allowlist** — it copies only `index.html`, `publicity.html`, `roster.html`, and `lib/` into a `dist/` directory and runs `wrangler pages deploy dist`. This keeps the Docker services (`publicity-server/`, `publicity-intake/`) and repo metadata off the public site, and any new directory is excluded by default. When adding a new static page, add it to the `cp` step in `deploy.yml` or it won't be published.

### publicity-server (Docker)
The API server runs via Docker Compose on-prem. The `docker-compose.yml` volume mounts:
- `./` → `/app` (server code)
- `../lib` → `/app/lib` (shared module — must be run from `publicity-server/` directory)

n8n drives the primary automation workflow (SD3 → API → publish). `publicity.html` is the manual fallback.

### publicity-intake (Docker)
The reliable, human-driven front door into the same n8n publicity workflow — a small Express app that serves a branded form and **proxies** the email + results file (`.sd3`/`.zip`) to the n8n webhook as `multipart/form-data`. Built to replace unreliable email submission.

- Auth is handled upstream by **Pangolin**; the app implements none of its own.
- Webhook URL is configured via the `N8N_WEBHOOK_URL` env var (server-side only — never in client code, so there's no SSRF/CORS surface).
- Optional shared-secret header auth: set `N8N_AUTH_HEADER` + `N8N_AUTH_TOKEN` and a matching n8n "Header Auth" credential. Both must be set or the header is omitted — don't enable Header Auth in n8n unless both are configured.
- Uploads are memory-only (no disk writes), capped at 256KB, validated client- *and* server-side.
- Compose publishes to `127.0.0.1` only; container runs non-root, read-only FS, all caps dropped.
- Unlike `publicity-server`, this image does **not** use `lib/` — it just forwards the file untouched; n8n does the parsing.

### Docker image tags (GHCR)
Both services build to `ghcr.io/gpsaswimming/<name>` via `.github/workflows/docker-publish*.yml`:
- Push to **`main`** → `:latest` + `:sha-<commit>`
- Push to **any other branch** → `:dev` + `:sha-<commit>` (for testing; `:dev` is a floating tag — use `:sha-<commit>` to pin a specific build)
- Builds are gated by `paths:` filters, so only changes to the relevant service trigger a rebuild. `publicity-intake/Dockerfile` builds with the repo root as context (paths are repo-root-relative).

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
- Do not add HY3 support to the publicity tool (SDIF only — see monolith DOCUMENTATION.md for rationale). **Exception:** `entry-fees-report.html` (the treasurer's per-team fee report) accepts `.hy3` because the league's *merged* entries file is Hy-Tek-native; the single-team tools (`publicity.html`, `entry-summary.html`) stay SDIF-only.
- Do not add regularly-updated content (meet results) here — that belongs in the `results` repo
- Do not commit `node_modules/` or raw SDIF files (`.sd3`, `.zip`)
- Do not commit `publicity-intake/.env` (holds `N8N_WEBHOOK_URL`) — it's gitignored; use `.env.example` as the template
- Do not publish the Docker services via Pages — keep the `deploy.yml` allowlist scoped to static pages + `lib/`
