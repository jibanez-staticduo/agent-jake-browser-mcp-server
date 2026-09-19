FROM node:22-alpine AS builder

ENV TZ=Europe/Madrid

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

ENV TZ=Europe/Madrid \
    NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache tini

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/http-server.js ./http-server.js
COPY --from=builder /app/healthcheck.js ./healthcheck.js
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN npm ci --omit=dev \
 && chmod +x /app/docker-entrypoint.sh \
 # The token store defaults to /app/data/tokens.json. Create it up front and
 # hand it to the unprivileged user, so the image works read-only-root with a
 # single writable volume mounted here.
 && mkdir -p /app/data \
 && chown -R node:node /app/data

# Nothing here needs root, and this server drives a browser holding the user's
# logged-in sessions: run it as the unprivileged user the base image ships.
USER node

EXPOSE 8765 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
