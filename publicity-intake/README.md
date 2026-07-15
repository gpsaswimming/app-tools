# publicity-intake

Internal web form that accepts a submitter email + an SDIF meet-results file and
forwards both to the n8n publicity webhook as `multipart/form-data`. It's the
reliable replacement for emailing results in (email delivery wasn't dependable).

Authentication is handled **upstream by Pangolin** — this service is only
reachable through the Pangolin tunnel and trusts that traffic is already
authenticated. It still validates and hardens its own surface (see below).

```
Submitter → Pangolin (auth) → publicity-intake (this) → n8n webhook → publish
```

This is the human/manual front door into the same workflow that
[`publicity-server`](../publicity-server) serves as an API for.

Before submitting, the form shows a **review stage** — it parses the chosen file
**in the browser** (shared [`swimparse`](../swimparse) + JSZip for `.zip`) and
displays the meet date, teams, and final score, flagging any file dated to a
previous year. This catches wrong-file / prior-season resubmissions. The parse
is a client-side courtesy check only; the server still forwards the file
**untouched** (it never parses), and a file that won't parse can still be
submitted with a warning.

## Endpoints

| Method | Path                 | Purpose                                              |
|--------|----------------------|------------------------------------------------------|
| GET    | `/`                  | The branded submission form                          |
| GET    | `/health`            | Health check (also reports whether the webhook is set) |
| GET    | `/vendor/swimparse/` | Read-only static mount of `../swimparse/src` for the browser preview |
| POST   | `/submit`            | Accepts `email` + `file`, forwards to n8n            |

## Configuration

| Env var           | Required | Default | Notes                                            |
|-------------------|----------|---------|--------------------------------------------------|
| `N8N_WEBHOOK_URL` | **yes**  | —       | The n8n webhook that receives the multipart POST |
| `N8N_AUTH_HEADER` | no       | —       | Header name for the n8n "Header Auth" secret. Set with `N8N_AUTH_TOKEN` to enable. |
| `N8N_AUTH_TOKEN`  | no       | —       | Secret value sent in `N8N_AUTH_HEADER`. Both must be set to enable auth. |
| `PORT`            | no       | `8080`  |                                                  |
| `HOST`            | no       | `0.0.0.0` | Bind address inside the container              |
| `N8N_TIMEOUT_MS`  | no       | `15000` | Upstream request timeout                         |

### Webhook auth (optional, recommended)

Set both `N8N_AUTH_HEADER` and `N8N_AUTH_TOKEN`, then configure a matching
**Header Auth** credential on the n8n webhook node (same header name + value).
Every forwarded request then carries the secret, so n8n rejects any POST that
doesn't — defence in depth on top of the URL being private. If either var is
unset the header is omitted (so do **not** enable Header Auth in n8n unless both
are set, or all submissions will fail with 401/403). `GET /health` reports
`webhookAuth: true|false` so you can confirm it's active.

Copy `.env.example` → `.env` and set `N8N_WEBHOOK_URL`. **Never commit `.env`.**

## Run locally

```bash
cd publicity-intake
npm install
N8N_WEBHOOK_URL=https://n8n.example.org/webhook/gpsa-results-intake npm run dev
# open http://localhost:8080
```

## Run via Docker

```bash
# from the publicity-intake/ directory, with a .env containing N8N_WEBHOOK_URL
docker compose up -d
```

The compose file publishes to `127.0.0.1:8080` only (never the public network),
runs the container as the non-root `node` user with a read-only filesystem,
`no-new-privileges`, and all capabilities dropped. Pangolin fronts it for auth.

The image is built/pushed to `ghcr.io/gpsaswimming/publicity-intake` by CI.

## Security posture

- **Auth** is Pangolin's job; this app does not implement its own.
- **Validation:** email format + `.sd3`/`.zip` extension checked client- *and*
  server-side. Single file, max 256KB, max 5 fields.
- **Memory-only uploads** — the file never touches disk (no temp files, no
  path-traversal surface). It's streamed straight to n8n.
- **No SSRF** — the webhook URL is a fixed env var, never user-supplied.
- **Optional shared-secret header** to the webhook (`N8N_AUTH_HEADER`/`N8N_AUTH_TOKEN`) so n8n can reject any POST that doesn't carry the secret, even if the URL leaks.
- **Tight CSP** (`default-src 'none'`), `nosniff`, `X-Frame-Options: DENY`.
- **Two runtime deps** (`express`, `multer`); `npm ci` against a committed
  lockfile, `--omit=dev`.

## Dependencies

- `express` — HTTP server + static hosting
- `multer` — multipart parsing (memory storage)

Outbound forwarding to n8n uses Node 22's built-in `fetch`/`FormData`/`Blob` —
no extra HTTP-client dependency.
