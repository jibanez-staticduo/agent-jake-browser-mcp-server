FROM node:22-alpine AS builder

ENV TZ=Europe/Madrid

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# a+rX: the runtime user is non-root, and a checkout made with a strict umask
# (files 0600) would otherwise crash it with EACCES on the first import.
RUN npm run build && chmod -R a+rX /app

FROM node:22-alpine

ENV TZ=Europe/Madrid     NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache tini

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/http-server.js ./http-server.js
COPY --from=builder /app/healthcheck.js ./healthcheck.js
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN npm ci --omit=dev   && chmod +x /app/docker-entrypoint.sh

EXPOSE 8765 8000

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
