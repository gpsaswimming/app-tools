FROM node:22-slim

WORKDIR /app

# Install dependencies first (layer cached until package.json changes)
COPY publicity-server/package*.json ./
RUN npm install --omit=dev

# Copy server and shared lib
COPY publicity-server/server.mjs ./
COPY lib/ ./lib/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
    CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
