FROM node:22-slim

WORKDIR /app

# Install production deps first (layer cached until package files change).
# npm ci requires a committed package-lock.json for reproducible installs.
COPY publicity-intake/package*.json ./
RUN npm ci --omit=dev

# App code + static form.
COPY publicity-intake/server.mjs ./
COPY publicity-intake/public/ ./public/

# Shared swimparse parser, served read-only to the browser for the results
# preview. Mounted at /vendor/swimparse (see server.mjs). Sibling of /app so the
# same '../swimparse/src' path resolves here and in local dev.
COPY swimparse/src/ /swimparse/src/

# Drop to the built-in unprivileged user.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
    CMD node -e "fetch('http://localhost:8080/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
