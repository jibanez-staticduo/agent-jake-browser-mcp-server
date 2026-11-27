# StaticDuo LAN setup

Set `AGENT_BROWSER_SETUP_FILE` separately on NAS, Defend (Fedora), and Ari. Mount the JSON file read-only with permissions restricted to the server user. Keep each instance's LiteLLM API key and standalone MCP bearer token in its own file. Restart the server after changing the file. Invalid configuration stops startup.

```json
{
  "origin": "https://browser.example.test",
  "wsUrl": "wss://browser.example.test/ws",
  "baseUrl": "https://llm.example.test/v1",
  "apiKey": "replace-with-instance-api-key",
  "mcpUrl": "https://queue.example.test/mcp",
  "mcpToken": "replace-with-standalone-mcp-bearer-token",
  "lanCidrs": ["192.0.2.0/24"],
  "trustedProxyIps": ["198.51.100.10"],
  "hostByIp": { "192.0.2.20": "Workstation" }
}
```

`origin` is the extension's exact HTTPS setup origin with no trailing slash. The remaining URLs use HTTPS or WSS and contain no credentials, query, or fragment. Configure the actual LAN client CIDRs. `hostByIp` is optional and works best with stable DHCP assignments. Users supply any missing host or profile in the approval page. Use one HTTP/WS replica per instance and persist the token store volume. In-progress exchanges expire after five minutes and are cleared on restart. An enabled setup file activates WebSocket token authentication and disables the older `/pair` endpoints. Existing valid WebSocket tokens continue to work.

## Nginx Proxy Manager

Give LAN clients a DNS answer that reaches Nginx Proxy Manager (NPM) directly over HTTPS. Apply the following two locations to the proxy host for the configured origin using its Advanced configuration. Replace the CIDR and upstream address in both. Keep NPM's usual location for the public site.

```nginx
location = /setup {
    satisfy all;
    allow 192.0.2.0/24;
    deny all;
    access_log off;
    proxy_cache off;
    proxy_pass http://198.51.100.20:8000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Agent-Jake-Client-IP $remote_addr;
}

location ^~ /setup/ {
    satisfy all;
    allow 192.0.2.0/24;
    deny all;
    access_log off;
    proxy_cache off;
    proxy_pass http://198.51.100.20:8000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Agent-Jake-Client-IP $remote_addr;
}
```

Set `trustedProxyIps` to the exact NPM egress IP seen on the backend socket. In proxy mode the server rejects all other peers and requires exactly one `X-Agent-Jake-Client-IP` containing a LAN IP. NPM overwrites that header. Ensure its `$remote_addr` is the verified address of the client. For a direct LAN listener use its socket address for the access rules. If global real-IP rules, public tunnels, or NAT can make internet requests look like LAN clients on this listener, use a LAN-only listener or apply the source restriction before that hop. Drop public ingress to these two locations and prevent direct/public access to the setup upstream. Keep setup URLs and request or response bodies out of ingress, CDN and application logs.

Omit `trustedProxyIps` only if the server socket sees the LAN client's own source address. In this mode the application ignores forwarding headers. Its built-in HTTP listener requires a TLS terminator or transport that preserves the source IP for normal browser use.

## Verification

Validate the active virtual host with `nginx -t` and inspect the effective locations with `nginx -T`. From a LAN client, complete an extension setup and verify the resulting label and browser connection. From outside the LAN, verify that the page and all three setup API routes are denied, including through the public hostname. Check that the normal public site still loads and previously paired browsers reconnect. The application contract tests run with `npm run build && npx vitest run tests/lan-setup.test.ts`.

## HTTP contract

The extension calls `POST /setup/start` with JSON containing optional `host` and `profile`. The server replies `201` with separate `approvalCode` and `pollSecret` values. The extension opens `GET /setup?code=<approvalCode>` as a top-level browser tab. The page removes the query from the address bar and calls `POST /setup/approve` on the same origin. The approval response has only `state` and, when a field is missing, a `missing` list with HTTP `422`.

The extension polls via `POST /setup/status` with JSON `{ "pollSecret": "..." }`. The first approved poll receives `{ state: "approved", config: { connectionId, label, wsUrl, token, baseUrl, apiKey, mcpUrl, mcpToken } }`. The server assigns a fresh UUID and binds the browser token to that UUID. It stores a distinct label for routing and keeps that label if the extension changes its local display name. Operators can change the routing name through `AGENT_BROWSER_CONNECTION_LABELS`. Use UUIDs for stable routing because users can supply host and profile names. A consumed or expired poll returns `{ state: "expired" }`. Start a new exchange if a connection drops before the extension can store its approved result.

## Repeat pairing and revocation

Browsers reconnect with their stored UUID and token after a normal restart. Starting setup again creates a separate identity. If the original host and profile are still reserved, the approval page asks for another profile name.

To revoke a lost or retired pairing, identify its UUID in the server's browser list or by its saved label. Stop the instance so that the current socket closes and the token store cannot be written concurrently. Back up the store to a private path, remove the entry for that UUID from `BROWSER_TOKEN_STORE`, and restart the instance. If the UUID or label also occurs in `AGENT_BROWSER_CONNECTION_LABELS` or `AGENT_BROWSER_DEFAULT_CONNECTION`, update those operator settings before reusing the label. Rotating a browser token only revokes that browser's WebSocket access. If the instance API key or MCP bearer token was exposed, revoke and replace it with its issuing service, update the private setup file, and reprovision affected browsers.
