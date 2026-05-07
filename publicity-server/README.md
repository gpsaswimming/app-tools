# GPSA Publicity API Server

REST API for processing SDIF swim meet results files. Designed for integration with n8n and other automation tools.

## Deployment

The server runs as a Docker container pulled from the GitHub Container Registry.

```bash
cd publicity-server
docker-compose up -d
```

To update to the latest image:

```bash
docker-compose pull && docker-compose up -d
```

The image is automatically rebuilt and pushed to `ghcr.io` on every push to `main` that touches `publicity-server/`, `lib/`, or `Dockerfile`, and weekly on a schedule to pick up base image security patches.

Server runs at `http://localhost:3000`.

## API Endpoints

### Health Check

```
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "version": "1.2",
  "timestamp": "2025-06-16T12:00:00.000Z"
}
```

### API Information

```
GET /api
```

### Process SDIF File

```
POST /api/process
Content-Type: multipart/form-data
```

**Request Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | SDIF file (.sd3, .txt, or .zip) |
| `override` | JSON string | No | Override configuration (see below) |

**Override Configuration:**
```json
{
  "enabled": true,
  "winnerCode": "GG",
  "reason": "Team forfeited due to insufficient swimmers"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "filename": "2025-06-16_GG_v_WW.html",
  "html": "<!DOCTYPE html>...",
  "metadata": {
    "meetName": "2025 Great Oaks v. Westfield",
    "meetDate": "2025-06-16",
    "teams": [
      {"code": "GG", "name": "Great Oaks", "score": 245.0},
      {"code": "WW", "name": "Westfield", "score": 198.0}
    ],
    "eventCount": 42
  }
}
```

## Error Responses

| HTTP Code | Condition |
|-----------|-----------|
| 400 | No file uploaded or invalid file type |
| 413 | File too large (max 256KB) |
| 422 | Invalid SDIF format or not a dual meet |
| 500 | Server error |

## Usage Examples

### cURL

```bash
# Basic usage
curl -X POST http://localhost:3000/api/process \
  -F "file=@meet_results.sd3"

# With override
curl -X POST http://localhost:3000/api/process \
  -F "file=@meet_results.sd3" \
  -F 'override={"enabled":true,"winnerCode":"GG","reason":"Forfeit"}'

# Save HTML output
curl -X POST http://localhost:3000/api/process \
  -F "file=@meet_results.sd3" \
  | jq -r '.html' > results.html
```

### n8n Integration

1. **HTTP Request Node:**
   - Method: `POST`
   - URL: `http://your-server:3000/api/process`
   - Body Content Type: `Form-Data/Multipart`

2. **Form Fields:**
   - `file`: Binary data from previous node (e.g., email attachment, webhook upload)
   - `override`: (Optional) JSON string for forfeit handling

3. **Response Processing:**
   - Access `$json.html` for the generated HTML
   - Access `$json.filename` for the suggested filename
   - Access `$json.metadata` for meet information

## Architecture

```
Dockerfile (repo root)
├── COPY publicity-server/package*.json → npm install
├── COPY publicity-server/server.mjs
└── COPY lib/publicity-core.js → lib/

publicity-server/
├── server.mjs          # Express API server
├── package.json        # Dependencies
├── docker-compose.yml  # Pulls image from ghcr.io
└── README.md           # This file
```

`lib/publicity-core.js` is shared between `server.mjs` (baked into the image) and `publicity.html` (browser import). Changes to the shared lib trigger an image rebuild automatically.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `NODE_ENV` | production | Environment mode |
