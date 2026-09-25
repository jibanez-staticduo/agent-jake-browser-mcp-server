#!/usr/bin/env sh
set -eu

# Run the local tsx, not `npx tsx`: npx wants a writable npm cache and may reach
# for the network, neither of which exists under a read-only root filesystem.
if [ -x /app/node_modules/.bin/tsx ]; then
  exec /app/node_modules/.bin/tsx /app/http-server.js
fi

exec npx tsx /app/http-server.js
