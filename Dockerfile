FROM node:22-alpine AS builder

ENV TZ=Europe/Madrid

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# 1Password CLI for browser_fill_secret (see README, 1Password).
FROM alpine:3.22 AS opcli
ARG OP_VERSION=2.39.0
ARG TARGETARCH=amd64
RUN apk add --no-cache curl unzip \
  && curl -fsSLo /tmp/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${TARGETARCH}_v${OP_VERSION}.zip" \
  && unzip -q /tmp/op.zip op -d /usr/local/bin && chmod 0755 /usr/local/bin/op

FROM node:22-alpine

ENV TZ=Europe/Madrid \
    NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache tini

COPY --from=opcli /usr/local/bin/op /usr/local/bin/op
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/http-server.js ./http-server.js
COPY --from=builder /app/healthcheck.js ./healthcheck.js
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN npm ci --omit=dev \
 && chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /app/data

# Existing Docker installs bind-mount host-owned token stores. Kubernetes sets
# runAsUser explicitly, while Docker retains the image's original UID behavior.

EXPOSE 8765 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
