#!/usr/bin/env bash
# Copia versionada en este fork del subset de aserciones de
# ~/mcp-servers/agent-browser/scripts/check-deltas.sh que le toca al server
# (deltas 1, 1b, 7b y 8). Ruling CTO DGX-309: el script compartido NO se mueve ni
# se cambia (lo usa el timer systemd de producción); esta copia está adaptada
# a un checkout de un solo repo, con rutas relativas a la raíz del repo.
# Un auto-update que revierta cualquiera de estos es un FALLO, no un exito.
set -u
cd "$(dirname "$0")/.."
fail=0
chk() { # chk <descripcion> <comando grep...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ok    $desc"; else echo "  FALLO $desc"; fail=1; fi
}
chk "1 WS server no escucha fijo en 0.0.0.0"        bash -c "! grep -q \"host: '0.0.0.0'\" src/ws-server.ts"
chk "1b WS server verifica token en handshake"      grep -q verifyClient src/ws-server.ts
chk "7b browser_state registrado en el server"      grep -q stateTools src/tools/index.ts
chk "8 pestañas del agente se cierran (tab-reaper)"   grep -q tabReaper http-server.js
chk "fill_secret y type no esconden el aviso de longitud de la extensión" grep -q "fieldWarning(response.result)" src/tools/interaction.ts
chk "cada sesión trabaja en su pestaña (session-tabs)" bash -c 'grep -q "sessionTabs.route(" http-server.js && grep -q "targetTabId" src/session-tabs.ts'
chk "versión publicada de la extensión en /download/latest.json" bash -c 'grep -q "/download/latest.json" http-server.js && test -f src/published-extension.ts'
exit $fail
