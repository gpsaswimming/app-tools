# GPSA Relay Builder — Python (FastAPI) service that shells out to the swimparse
# Node CLI. Build context is the repo root so we can copy in ../swimparse.
FROM python:3.12-slim

# Node is needed only to run the swimparse CLI (pure ESM, zero npm deps).
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first (layer cached until requirements change).
COPY relay-builder/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App code + the shared parser (single source of truth, copied not vendored).
COPY relay-builder/app ./app
COPY swimparse ./swimparse

ENV SWIMPARSE_CLI=/app/swimparse/cli.js \
    RELAY_DB=/data/relay.db

# Unprivileged user; /data is a writable volume for the SQLite file.
RUN useradd --create-home appuser \
    && mkdir -p /data \
    && chown appuser /data
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').getcode()==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
