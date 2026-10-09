# Agent Jake Browser MCP Server

An MCP (Model Context Protocol) server that enables AI agents to automate Chrome browser interactions.

## Overview

This server implements the MCP protocol to expose browser automation tools to AI agents like Claude. It works in conjunction with [agent-jake-browser-mcp-extension](https://github.com/SnakeO/agent-jake-browser-mcp-extension) to provide full browser control.

## Architecture

```
┌─────────────────┐     stdio      ┌─────────────────┐   WebSocket    ┌──────────────────┐
│   AI Agent      │◄──────────────►│   MCP Server    │◄──────────────►│ Chrome Extension │
│ (Claude, etc.)  │   JSON-RPC     │  (This project) │   port 8765    │                  │
└─────────────────┘                └─────────────────┘                └────────┬─────────┘
                                                                               │
                                                                               │ Chrome
                                                                               │ Debugger
                                                                               │ API
                                                                               ▼
                                                                      ┌──────────────────┐
                                                                      │   Browser Tab    │
                                                                      │  (Any website)   │
                                                                      └──────────────────┘
```

## Installation

```bash
git clone https://github.com/SnakeO/agent-jake-browser-mcp-server.git
cd agent-jake-browser-mcp-server
npm install
npm run build
```

## Usage

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/agent-jake-browser-mcp-server/dist/index.js"]
    }
  }
}
```

### With VS Code / Cursor

Add to your MCP settings:

```json
{
  "mcp.servers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/agent-jake-browser-mcp-server/dist/index.js"]
    }
  }
}
```

### Infrastructure

Docker recipes, healthchecks and Kubernetes manifests belong to the house
infrastructure repository. StaticDuo's extraction destination is
`nas-docker/mcp/agent-jake-browser/`; its `migration-source.json` records hashes
of the infrastructure copied from server SHA `846dab66`.

Build this product with `npm ci && npm run build`. Infrastructure consumes the
root artifacts `dist/index.js` (stdio) and `dist/http-server.js` (HTTP).
The compatibility command `node http-server.js` also runs compiled HTTP.
The HTTP listener defaults to loopback; a deployment that changes the bind host
must provide its own authenticated proxy and network boundary.

### CLI Options

```bash
node dist/index.js [options]

Options:
  --port <number>    WebSocket port for extension connection (default: 8765)
  --verbose          Enable verbose logging
  --help             Show help
```

## Several browsers, tokens and pairing

More than one browser can be attached at the same time. Each extension install
connects with its own `connectionId`, and every tool accepts an optional
`connection` argument choosing which browser runs the call. Without it the
server targets the most recently used connection, so single-browser setups keep
working exactly as before.

```json
{ "name": "browser_navigate", "arguments": { "url": "https://example.com", "connection": "chrome-office" } }
```

`browser_list_connections` answers with the live browsers (id, label, client IP,
socket peer IP, IP source, user agent,
last activity and which one is active) and is answered by the server itself, so it
also works while nothing is connected.

The connections page displays the manual label first, then `IP <clientIp>`, then
`Desconocido`. IP metadata is collected on the next browser reconnection and
works with older extensions that send no label. An IP identifies the observed
NAT/VPN egress, not a reliable hostname or a unique device.

By default, IP metadata comes from the socket and forwarded headers are ignored.
For a single trusted edge proxy such as Nginx Proxy Manager with dynamic addresses,
set `BROWSER_TRUST_PROXY=true` and enable token or pairing authentication. This
flag trusts forwarded metadata on authenticated connections without a fixed IP
allowlist; it has no effect when authentication is disabled. Restrict the network
and proxy path externally: an authenticated direct client holding a valid token
can also supply this informational metadata when the flag is enabled. Forwarded
IP is not an authentication identity. Alternatively, leave the flag off and set
`BROWSER_TRUSTED_PROXY_IPS` to the proxy's actual socket IP. Ensure the proxy appends
its observed client to `X-Forwarded-For` and overwrites `X-Real-IP` with
`$remote_addr`. The rightmost IP in a valid single `X-Forwarded-For` header is
preferred (Nginx's
`$proxy_add_x_forwarded_for` appends its observed client); `X-Real-IP` is used only
when `X-Forwarded-For` is absent. Malformed or duplicate
headers fall back to the socket. This does not traverse multiple proxy hops.
Keep the exact proxy address current when Docker networking changes. This
metadata does not change authentication or browser routing.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROWSER_WS_HOST` | `127.0.0.1` | Bind address of the extension WebSocket. Set `0.0.0.0` when a reverse proxy reaches it from outside the container. |
| `BROWSER_WS_PORT` | `8765` | Extension WebSocket port. |
| `BROWSER_TRUST_PROXY` | `false` | Exact `true` trusts forwarded IP metadata on authenticated connections, taking priority over the IP allowlist. Requires static token or pairing authentication; enforce the trusted proxy/network path externally. |
| `BROWSER_TRUSTED_PROXY_IPS` | empty | Comma-separated exact proxy IP literals (IPv4 or IPv6). No CIDR, hostnames or ports; any invalid entry disables the IP allowlist. |
| `BROWSER_WS_TOKEN` | empty | Shared token required in the handshake (`?token=`). Empty disables static auth. |
| `BROWSER_ALLOW_PAIRING` | `false` | `true` also accepts tokens issued by the pairing web. Auth is on when this or the static token is set. |
| `BROWSER_TOKEN_STORE` | `/app/data/tokens.json` | JSON file where issued tokens live, so they survive a restart. Mount a volume for the path. |
| `BROWSER_EXTENSION_ZIP` | `/app/extension/agent-jake-browser-extension.zip` | Archive served at `/download`. |
| `BROWSER_PUBLIC_WS_URL` | derived | Full `ws(s)://host/path` handed to the extension. Use it when the proxy mapping is not derivable from the request. |
| `BROWSER_WS_PATH` | `/` | Path advertised to the extension, for proxies that map the socket to a subpath. |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | `127.0.0.1` / `8000` | MCP streamable HTTP endpoint. |
| `BROWSER_PUBLIC_ORIGIN` | derived | Origin used to build the approval link returned by `/pair/start`. Set it when the proxy host is not derivable from the request. |
| `AGENT_BROWSER_OUT_DIR` | system temp dir | Where `browser_pdf` and tool results saved with `filename` write their files. |
| `AGENT_BROWSER_DROP_DIR` | unset (file drops disabled) | Directory of files available to `browser_drop`. Files must be direct children, with no symlinks; maximum 8 files and 10 MiB total per call. Mount only files intended for browser upload. MIME data-only drops remain available with a 1 MiB limit. |
| `AGENT_BROWSER_FILL_SECRET_ENABLED` | unset (OFF) | Only the exact value `true` registers `browser_fill_secret`. Enable after validating that the installed extension preserves the secret flag, redacts logs, and returns `{ typed: true, verified: true }`. |
| `AGENT_BROWSER_ALLOW_UNSAFE_CODE` | unset (disabled) | Set exactly `1` to enable `browser_run_code_unsafe`, which executes arbitrary JavaScript in the MCP server process. Only use it with fully trusted MCP clients. |

PDFs and network or console results written with a path must be direct children of
`AGENT_BROWSER_OUT_DIR` (or the system temp directory by default). Existing files
are never overwritten; choose a new name for each result. Secure file drops and
server-side output files currently require Linux (`/proc/self/fd`); they fail
closed on other platforms. Data-only drops and inline tool results still work.

`browser_network_request` returns metadata and headers by default. Only values
of `content-type` (MIME type only), `content-length` (digits only), and
`cache-control` (known directives only) remain visible; other header values
are redacted. Network URLs show only the origin, never the path, query,
userinfo or fragment. Request or response bodies require an explicit `part`
because they can contain credentials or private form data. Custom header names
can also carry private data, so use these tools only with trusted MCP clients.

### HTTP surface

| Route | Purpose |
| --- | --- |
| `POST /mcp` (plus `GET`/`DELETE`) | MCP streamable HTTP endpoint. |
| `GET /` | Small page with the download link, the pairing link and the live connection list. |
| `GET /download` | Serves the extension zip from `BROWSER_EXTENSION_ZIP`. |
| `GET /connections` | JSON: auth status, derived wsUrl and the current connections. |
| `POST /pair/start` | Extension registers a one-time code (`{otp, connectionId?, label?}`), valid 10 minutes. |
| `GET /pair` | Approval page, prefilled from `?otp=`. |
| `POST /pair/approve` | `{otp}` → `{token, wsUrl}`; `410` when expired, unknown or already used. |
| `GET /pair/status?otp=` | `pending` \| `approved` \| `expired`, with the token once approved. |

Pairing means each install gets its own token instead of sharing one secret: the
extension shows a code, a human approves it in the browser, and the issued token is
stored on disk and accepted by the WebSocket handshake afterwards.

### Download with the server address baked in

When `BROWSER_PUBLIC_WS_URL` is set, `/download` injects a root-level `config.json`
into the archive before sending it:

```json
{ "version": 1, "wsUrl": "wss://agent-browser.staticduo.com/ws" }
```

The template mounted at `BROWSER_EXTENSION_ZIP` stays read-only and untouched; the
patched archive is built in memory and cached until the template or the URL changes.
Without `BROWSER_PUBLIC_WS_URL` the template is served byte for byte, and no token is
ever written into the archive — authentication comes from pairing.

## Tools

### Navigation (4 tools)

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_go_back` | Go back in browser history |
| `browser_go_forward` | Go forward in browser history |
| `browser_reload` | Reload the current page |

### Page Inspection (1 tool)

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get ARIA accessibility tree snapshot of the page |

### Interaction (6 tools)

| Tool | Description |
|------|-------------|
| `browser_click` | Click on an element |
| `browser_type` | Type text into an input field |
| `browser_hover` | Hover over an element |
| `browser_drag` | Drag an element to another location |
| `browser_select_option` | Select an option from a dropdown |
| `browser_press_key` | Press a keyboard key or combination |

### Element Queries (5 tools)

| Tool | Description |
|------|-------------|
| `browser_get_text` | Get text content of an element |
| `browser_get_attribute` | Get an attribute value from an element |
| `browser_is_visible` | Check if an element is visible |
| `browser_wait_for_element` | Wait for an element to appear |
| `browser_highlight` | Highlight an element for debugging |

### Tab Management (4 tools)

| Tool | Description |
|------|-------------|
| `browser_new_tab` | Open a URL in a new tab |
| `browser_list_tabs` | List all open browser tabs |
| `browser_switch_tab` | Switch to a different tab |
| `browser_close_tab` | Close a browser tab |

### Utility (3 tools)

| Tool | Description |
|------|-------------|
| `browser_wait` | Wait for a specified time |
| `browser_screenshot` | Take a screenshot of the page |
| `browser_get_console_logs` | Get console log messages |

### Connections (1 tool)

| Tool | Description |
|------|-------------|
| `browser_list_connections` | List the browsers attached to this server, answered without a browser |

## Example Usage

Once connected, the AI agent can use these tools:

```
AI: I'll help you fill out that form. First, let me take a snapshot of the page.
[calls browser_snapshot]

AI: I can see the form fields. Let me fill in your name.
[calls browser_type with ref="e12", text="John Doe"]

AI: Now I'll click the submit button.
[calls browser_click with ref="e15"]
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development with watch
npm run dev

# Run tests
npm test

# Type checking
npm run typecheck
```

## Project Structure

```text
packages/
  core/
    src/
      product.ts       # Importable API; no listener starts on import
      cli/             # Compiled stdio and HTTP process entrypoints
      http/            # HTTP routes and existing pairing/download pages
      server.ts        # MCP server
      context.ts       # Browser communication
      ws-server.ts     # WebSocket authentication and routing
      tools/           # Shared tools and pinned-directory safeguards
      utils/           # Shared utilities
    tests/             # Product tests, including HTTP process integration
  house-staticduo/     # Identity and composition only
  house-pocharlies/    # Identity and composition only
tests/integration/    # Browser E2E; extension artifact supplied by configuration
entrypoints/          # Root dist compatibility wrappers
```

The root owns the only lockfile. `npm ci`, `npm run typecheck`, `npm test`,
`npm run build`, `npm start` and `npm run dev` remain root commands.
The two house packages compose the same core; they contain no tool copies,
domains, credentials or deployment configuration.

Browser integration uses an unpacked extension artifact supplied through
`BROWSER_EXTENSION_PATH` (default `./test-artifacts/extension`). It never
requires a neighboring checkout. Example after building the server:

```sh
BROWSER_EXTENSION_PATH=/path/to/pinned/extension npm run test:e2e
```

See [migration inventory](docs/migration-inventory.md) and the
[current wire contract](docs/contracts/browser-harness-v1.md).

## Tech Stack

- Node.js
- TypeScript
- MCP SDK (@anthropic/mcp-sdk)
- Zod for schema validation
- WebSocket (ws) for extension communication
- tsup for bundling

## Related

- [agent-jake-browser-mcp-extension](https://github.com/SnakeO/agent-jake-browser-mcp-extension) - Chrome extension that executes browser commands

## License

MIT - See [LICENSE](LICENSE)

## 1Password

`browser_fill_secret` reads `op://vault/item/field` with the 1Password CLI (`op read`) on the server
machine and types it with `browser_type`, flagged `secret`. The server omits the value from this tool's
result and does not forward reader stderr or browser/transport error text. The result only says how
many characters were typed. This is not a guarantee against reading the page with another tool.

Use only an extension that preserves `secret` and redacts both request and response logs. Legacy
extensions may discard the flag and log the typed value; installing this server alone does not fix
their behavior. Selector-only targeting also requires a compatible extension; older versions require
an element `ref`. Verify the paired extension before enabling secret fills in an installation.

The packaging installer `scripts/install-op.sh` supports 1Password CLI 2.39.0 for linux/amd64 and linux/arm64. Builds select the effective
target architecture and verify pinned archive hashes before installing or executing the CLI. An
incompatible explicit `TARGETARCH`, unsupported architecture or unverified `OP_VERSION` fails the build.
Cross-platform builds need native builder nodes or emulation for each target platform.

Pick the backend with `AGENT_BROWSER_OP_BACKEND`:

- `service-account`: requires a nonblank `OP_SERVICE_ACCOUNT_TOKEN`, without silently falling back to a desktop login. On Families and Teams plans every service account of the
  account shares one daily request quota (1,000 a day on Families), so an agent that logs in often can
  exhaust it for everything else that uses 1Password.
- `connect`: a [1Password Connect](https://developer.1password.com/docs/connect/) server
  (`OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`). Connect keeps a local copy of the vaults it is granted and only
  spends quota on its own sync, so reads are unlimited.

With Connect, `op read` works, TOTP included (`op://vault/item/<OTP field id>?attribute=otp`), but the CLI
refuses `op item list` and needs `--vault` plus `--format json` for `op item get`. Connect matches a
field reference by its **label**, so a field with no label cannot be read. Strip the trailing newline
from the token printed by `op connect token create` before storing it, or the Authorization header breaks.


Secret fills are disabled by default. Only the exact value
`AGENT_BROWSER_FILL_SECRET_ENABLED=true` registers `browser_fill_secret` in HTTP
and stdio. Keep it disabled until every target extension preserves the secret
flag, redacts request and response logs, and acknowledges successful fills with
`{ typed: true, verified: true }`. Missing acknowledgements, failed verification,
and warnings return a fixed error without reflecting the remote payload.

`AGENT_BROWSER_OP_BIN` defaults to `op` and must implement `<bin> read <ref>`.
`AGENT_BROWSER_OP_BACKEND` unset preserves the reader environment; it does not
enable the tool. Configure `connect` or `service-account` as described above.
