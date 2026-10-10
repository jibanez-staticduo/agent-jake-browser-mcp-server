# Current Browser Harness wire contract

This document describes the existing M1A behavior. The filename is a documentation
identifier; no protocol version is negotiated or advertised by this change.

## Processes and configuration

Stdio runs as `node dist/index.js` with existing `--port`, `--verbose` and
`--kill-existing` options. The WebSocket default remains 8765. HTTP runs as
`node dist/http-server.js`, or the compatible `node http-server.js` shim.
HTTP defaults to port 8000 and host `127.0.0.1`; WebSocket also defaults to
loopback. Existing `MCP_*`, `BROWSER_*` and `AGENT_BROWSER_*` variables retain
their behavior. URLs and token storage paths come from runtime configuration.

## WebSocket

The upgrade URL carries optional `token`, `connectionId` and `label` query
parameters. Authentication is enabled by `BROWSER_WS_TOKEN` or
`BROWSER_ALLOW_PAIRING=true`; failed authentication rejects the upgrade with 401.
With neither configured, the existing unauthenticated mode remains available.
There is no hello/version/capability exchange. Missing connection IDs receive an
anonymous ID; reconnecting the same ID replaces its previous socket.

Server requests are `{ id: string, type: ToolName, payload: object }`.
Extension replies are `{ id: string, success: boolean, result?: unknown,
error?: { code: string, message: string } }`. Heartbeat messages with
`type: 'heartbeat'` are accepted separately. M1A preserves the current correlation
and selection behavior; session binding belongs to M1B.

## MCP and selection

Both transports expose MCP `tools/list` and `tools/call` with standard JSON-RPC
and MCP result envelopes. HTTP retains its existing per-tool `connection` schema
annotation and sessionless `tools/list` convenience route. The catalogs are not
unified in this extraction. The `connection` argument is stripped before the
tool reaches the extension. An explicit unknown connection is rejected; without
selection, the existing most recently used/single-browser behavior applies.
`browser_list_connections` is server-side and needs no connected browser.
Extension error responses, including its Copilot busy gate, retain the same
result mapping; no lease or routing code is changed here.

## HTTP distribution and pairing

Routes remain `/`, `/healthz`, `/connections`, `/download`, `/pair`,
`POST /pair/start`, `POST /pair/approve`, `GET /pair/status`, and
`POST/GET/DELETE /mcp`. The MCP HTTP endpoint has no intrinsic authentication;
operators provide its proxy/network boundary when exposing it.

Pairing uses an OTP with the existing expiry and one-time approval behavior.
Approval issues a token through the existing persistent JSON token store.
`BROWSER_PUBLIC_WS_URL` overrides the URL served to the extension; proxy headers
and direct-access defaults retain their existing precedence. Download patches
`config.json` in memory when a public WebSocket URL is configured, without
altering the mounted ZIP. Credentials are not embedded in this document or in
house packages.

Pinned-directory file safety and unsafe-code defaults remain shared product
behavior. This extraction does not change their platform guarantees.

## HTTP session and tab lifetime extension

The first HTTP browser call resolves the explicit connection, or the existing
active/single-browser choice, then pins the chosen browser to that MCP session.
An explicit connection changes its subsequent target. Calls cannot cross a socket
replacement midway through one operation.

Only tabs opened by a session are tracked for cleanup. Closing by ID requires
`closeById: true` in the tab listing and an exact echoed ID. Old extension builds
fail closed. Ownership is discarded after every socket reconnection because tab
IDs and URLs cannot prove browser-session identity. Secret fills remain disabled
unless explicitly enabled, and require verified boolean acknowledgements.
