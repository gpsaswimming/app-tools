FROM node:22-slim

WORKDIR /app

# Install production deps first (layer cached until package files change).
# npm ci requires a committed package-lock.json for reproducible installs.
COPY publicity-intake/package*.json ./
RUN npm ci --omit=dev

# App code + static form.
COPY publicity-intake/server.mjs ./
COPY publicity-intake/public/ ./public/

# Drop to the built-in unprivileged user.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
    CMD node -e "fetch('http://localhost:8080/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
