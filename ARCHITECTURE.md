# ARCHITECTURE — agent-browser-server

Servidor MCP que recibe las órdenes del agente y las ejecuta en un Chrome real a través de `agent-browser-extension`. Fork de `jibanez-staticduo/agent-jake-browser-mcp-server`.

## Clientes y versiones

- Clientes MCP: las sesiones de Claude/opencode de la compañía (HTTP `/mcp`, servidor `agentjake-browser` en k8s) y el modo stdio clásico (`dist/index.js`) para uso local.
- Navegadores emparejados: varios a la vez (por ejemplo `mac` y `x86`), elegidos con el parámetro `connection` y fijados por sesión MCP (`src/connection-target.ts`).
- Versión: `package.json` 1.0.0 (el paquete sigue llamándose `agent-jake-browser-mcp-server`). Sin otros clientes.

## Dependencias (en ambos sentidos)

- Depende de: `agent-browser-extension` (WebSocket, puerto 8765, token por pairing) y del CLI `op` 2.39.0 de 1Password (para `browser_fill_secret`, con `OP_SERVICE_ACCOUNT_TOKEN`).
- Dependen de él: el MCP `browser` de todas las sesiones y el repo `k8s-agentjake-browser-mcp-pocharlies` (`k8s/base/manifest.yaml`, app `agentjake-browser`). El `ci.yml` de este repo no construye imagen (no verificado dónde se construye y publica).
- `deploy/k8s/` de este repo es una guía genérica con `ghcr.io/OWNER/...`; el despliegue real está en el repo k8s.

## Stack

Node 22, TypeScript 5.9, tsup 8.5, `@modelcontextprotocol/sdk` ^1.30.1, express 5, ws 8, zod 4, Vitest 4 y Playwright 1.57. Imagen: `node:22-alpine` + `tini` + CLI `op`.

## Componentes compartidos

- `src/tools/` (`navigation`, `interaction`, `queries`, `snapshot`, `state`, `tabs`, `utility`, `connections`, `pinned-directory`): una herramienta MCP por función; cada una espeja un handler de la extensión.
- `src/token-store.ts` y `src/pairing-store.ts`: emisión y verificación de tokens; la autenticación del handshake WebSocket va solo ahí (`verifyClient` en `src/ws-server.ts`).
- `src/connection-target.ts`: qué navegador recibe cada llamada.
- `http-server.js`: transporte HTTP streamable (`/mcp`), rutas de pairing y `POST /extension/reload` (solo loopback).
- `src/tab-reaper.ts`: qué pestañas abrió cada sesión MCP y su cierre al acabar la sesión o por inactividad; lo cablea `http-server.js`.
- `src/published-extension.ts`: la extensión que el CI publicó aquí tras un merge a main (`BROWSER_EXTENSION_DIR`, por defecto `/data/extension` en el PVC): `GET /download/latest.json` (versión, build, sha, fecha) para el aviso de versión nueva de las extensiones instaladas, y el zip que sirve `/download`.
- `src/session-tabs.ts`: cada sesión MCP trabaja en su pestaña aunque compartan navegador. Manda `targetTabId` en cada comando, encola los comandos por navegador (también los del reaper, vía `system`) y responde `NO_SESSION_TAB` a una sesión sin pestaña cuando la conectada es de otra; lo cablea `http-server.js`.

## Cómo se construye

Una herramienta nueva = fichero en `src/tools/` + registro en `src/tools/index.ts` + el handler en la extensión, con test. El servidor HTTP escucha en `127.0.0.1` por defecto (`MCP_HTTP_HOST`); abrirlo a la red es decisión del despliegue, no del código. Cambio nuevo = rama + PR contra `main`.

## Tests

`npm run typecheck`, `npm test` (Vitest: `server`, `ws-server`, `token-store`, `pairing-store`, `connection-target`, `http-routes`, `fill-secret`, `deploy-k8s`…) y `npm run test:e2e` (Playwright, no en CI).

## CI/CD y despliegue

`ci.yml` en `arc-k8s`: `build-test` (tsc + vitest, Node 22.23.2 verificado por sha256) y `deltas` (`scripts/check-deltas.sh`: sin bind fijo a `0.0.0.0`, `verifyClient` presente, `stateTools` registrado, `tabReaper` cableado); además los workflows estándar `duplicados.yml` y `pr-review.yml`. El despliegue lo lleva `k8s-agentjake-browser-mcp-pocharlies` (ArgoCD); este repo no se despliega solo.

## Decisiones y trampas

- Los cuatro `deltas` de `check-deltas.sh` son la defensa frente a un auto-update del upstream: nunca se retiran.
- `session-tabs` necesita la extensión con `routeToTargetTab` (agent-browser-extension#23): **se despliega primero la extensión**, luego esta imagen. Una extensión vieja ignora `targetTabId` y actúa en la pestaña conectada, como antes (no se detecta: nota abierta para anunciarlo en `browser_list_tabs`, como `closeById`). La extensión atiende mensajes en paralelo: la atomicidad de «conectar a la pestaña + ejecutar» la da la cola de aquí.
- El WebSocket nunca escucha en `0.0.0.0` sin token; el handshake exige token.
- `browser_fill_secret` lee `op://…` en el servidor: el secreto no pasa por el transcript del agente.
- `browser_passkey` (INFRA-585) manda `mode` y el objetivo a la extensión, que hace la ceremonia con la passkey propia del agente guardada en el navegador: la clave nunca llega al servidor. Error si la extensión no conoce la herramienta, si responde sin informe de passkey o si el guard de WebAuthn no volvió (pide cerrar la pestaña). En AgentGateway va con la misma puerta que `browser_fill_secret`.
- Renombrar una herramienta MCP rompe a todas las sesiones: se añade una nueva y se deja la vieja.
- Las pestañas que abre un agente (`browser_new_tab` o un clic que abre otra) se cierran solas al acabar su sesión MCP o tras 60 min sin uso (`src/tab-reaper.ts`; `AGENT_BROWSER_TAB_IDLE_MINUTES`, 0 lo apaga). Las que no abrió el agente no se tocan nunca. `keepOpenMinutes` (máx. 1440) en `browser_new_tab`/`browser_switch_tab` retiene la de un pago que espera a Dani; si su sesión acabó y otra trabaja en ella (`confirmar_pago`), pasa a ser de esa. Solo en el transporte HTTP: en stdio el proceso es la sesión y es local de un solo usuario. El registro vive en memoria: un reinicio del pod olvida las pestañas abiertas antes. Cierra por id solo en un navegador cuya extensión anuncia `closeById` en `browser_list_tabs` (`agent-browser-extension#18`; las anteriores cerraban la conectada) y da el cierre por bueno solo si la extensión devuelve ese id.
- Clones duplicados en el host: ver C5 de SC-1425.
