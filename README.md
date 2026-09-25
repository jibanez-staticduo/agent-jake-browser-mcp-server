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

### On Kubernetes

The server also runs as a pod, with the browser staying on your own machine —
useful when the agents that drive it already live in the cluster. Manifests and
the security contract that comes with them are in
[`deploy/k8s/`](deploy/k8s/README.md):

```bash
docker build -t <registry>/agent-jake-browser-mcp-server:<tag> .
# edit deploy/k8s/kustomization.yaml, configmap.yaml, ingress.yaml
kubectl apply -k deploy/k8s
```

Agents then reach it over streamable HTTP at
`http://agent-jake-browser.agent-jake-browser.svc:8000/mcp`, and browsers pair
from wherever they are.

One thing not to skip: in a pod the MCP endpoint cannot bind loopback, which is
the only thing protecting it on a laptop. `deploy/k8s/networkpolicy.yaml`
replaces that boundary and is part of the deployment, not an optional extra.

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

`browser_list_connections` answers with the live browsers (id, label, user agent,
last activity and which one is active) and is answered by the server itself, so it
also works while nothing is connected.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROWSER_WS_HOST` | `127.0.0.1` | Bind address of the extension WebSocket. Set `0.0.0.0` when a reverse proxy reaches it from outside the container. |
| `BROWSER_WS_PORT` | `8765` | Extension WebSocket port. |
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
| `AGENT_BROWSER_ALLOW_UNSAFE_CODE` | unset (disabled) | Set exactly `1` to enable `browser_run_code_unsafe`, which executes arbitrary JavaScript in the MCP server process. Only use it with fully trusted MCP clients. |

PDFs and network or console results written with a path must be direct children of
`AGENT_BROWSER_OUT_DIR` (or the system temp directory by default). Existing files
are never overwritten; choose a new name for each result. Secure file drops and
server-side output files currently require Linux (`/proc/self/fd`); they fail
closed on other platforms. Data-only drops and inline tool results still work.

`browser_network_request` returns metadata and headers by default. Only values
of common diagnostic headers (`accept`, `cache-control`, `content-encoding`,
`content-length`, `content-type`, `date`, `server`, `vary`) remain visible; other
header values are redacted. Network URLs hide userinfo, query values and
fragments. Request or response bodies require an explicit `part` because they
can contain credentials or private form data. Custom headers and path segments
can still carry private data, so use these tools only with trusted MCP clients.

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

```
src/
├── index.ts           # Entry point
├── server.ts          # MCP server implementation
├── context.ts         # Extension communication context
├── ws-server.ts       # WebSocket server for extension
├── types.ts           # TypeScript type definitions
├── tools/             # Tool implementations
│   ├── index.ts       # Tool registry
│   ├── navigation.ts  # Navigate, back, forward, reload
│   ├── snapshot.ts    # ARIA snapshot
│   ├── interaction.ts # Click, type, hover, drag
│   ├── queries.ts     # Get text, attributes, visibility
│   ├── tabs.ts        # Tab management
│   └── utility.ts     # Wait, screenshot, console logs
└── utils/             # Utilities
    ├── logger.ts      # Logging
    └── port.ts        # Port management
```

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
