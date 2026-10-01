# Browser Harness M1B: proposed shared contract

Date: 2026-10-01. Status: proposal for agreement with Oppo through Marlin.
This PR contains design only. It does not implement a new wire, publish a package,
merge implementation PRs, alter configuration, or deploy an image.

## Outcome and acceptance

Agree one browser-compatible protocol source, explicit WS negotiation, browser
selection per MCP session, and request ownership across both canonical products.
The server and extension proposals must name the same messages, errors,
compatibility policy, security boundary, and implementation gates. Existing M1A
wire tests remain executable. Runtime implementation follows contract agreement;
image rollout still requires the separately recorded explicit Dani OK.

Verified baseline: canonical server `master` merge
`f6b98d51b830aebd95d0124a27efbacfed3807e8` and extension `master` merge
`cc3b59204f1864c4cff2c9be1f7cc8bcf83d6dc0`. Both M1A PR #2 merges were read back
from GitHub. Their product fork `main` branches and installed services are separate
from these canonical branches; merging a proposal does not update either.

## Evidence and alternatives

Current server HTTP transports share a context (`packages/core/src/http/server.ts`),
the connection registry resolves a global last-used browser, and pending WS calls
are correlated only by request ID (`connection-registry.ts`, `ws-server.ts`). The
extension marks OPEN as connected and may send an old operation's result through
its replacement socket (`packages/core/src/background/ws-client.ts` in the
extension repository). These are ownership defects, not proof of a reported
production exploit. The existing legacy contract is in
`docs/contracts/browser-harness-v1.md`; its title does not identify a negotiated
Browser Harness version.

| Transition | Assessment |
| --- | --- |
| Detect missing hello and fall back on the same socket | Reject: a timeout or incompatible client would silently bypass negotiation |
| One listener with an explicit operator-selected mode | Possible, but mixed dispatch and proxy flags increase the review surface |
| Separate negotiated endpoint and explicitly enabled legacy endpoint | Recommended: isolated parsers, unambiguous mode, reproducible rollback |

Recommend a configurable negotiated WS endpoint (proposed path `/ws/harness`),
with the existing legacy service left unchanged until an authorized rollout.
The eventual listener/port mapping belongs to infrastructure; `18766` is a proposed
local negotiated port, not a discovery rule. The public WSS domain remains operator
configured. No path or port is appended to an existing manually entered URL by
guesswork. A new deployment composition defaults to negotiated-only. Temporary
legacy support needs explicit operator enablement, an owner and a removal plan;
it never activates because hello failed. Existing deployments retain their current
configuration until that separate transition is approved.

## Source and distribution

Propose `@agent-jake-browser/protocol`, sourced only in server `packages/protocol`.
It contains pure ESM runtime schemas, inferred types, version negotiation, errors,
and browser-tool descriptors (name, arguments, result, risk, capability). No Node,
Chrome, house, credentials, public URL, transport, or filesystem imports belong in
this package. Core depends inward on protocol; house adapters depend on core and
inject trusted configuration. Protocol/core never import a house adapter.

HTTP and stdio schemas and the extension's Copilot browser-tool subset derive from
these descriptors. Copilot-local `ask_user`, `update_plan`, and `present_plan` stay
local. Platform/house availability filters descriptors, never maintains a second
schema definition. Preserve standard MCP JSON-RPC and `CallToolResult`; harness
results are adapted inside `content`/`structuredContent`, with `isError` as needed.

The initial proposed negotiated wire version is integer `1`. Legacy remains
unversioned; it is not a compatible member of `[1]`. Proposed experimental package
semver is `0.1.0`; package semver, MCP initialize version, harness wire version,
catalog digest, source SHA, and tarball hash are distinct identifiers.

For implementation PRs, generate one `.tgz` and vendor those exact bytes in the
extension, rather than require a sibling checkout or publish to an unagreed
registry. Dependency: an exact local tarball path, never a floating range.
`vendor/protocol/provenance.json` records package/version, canonical source SHA,
source lockfile digest, build toolchain, supported wire versions, catalog digest,
and tarball SHA-256. The extension lockfile also records npm integrity. Verify
provenance/hash before install and in CI, inspect pack contents and execute a
browser import. A source-linked textual diff accompanies the binary in the PR.
The server consumes the same workspace source; integration CI verifies that its
source and the vendored package match. A tag or replaceable release asset alone
does not prove immutability. Publishing a registry package/release is out of scope.

The catalog digest is `sha256:<lowercase hex>` over UTF-8 canonical JSON of
descriptors sorted by tool name; recursively sort object keys and retain array
order. Descriptors contain JSON-serializable metadata only. One pure serializer
and build-produced digest are shared. CI recomputes it. Initial policy is exact
digest equality, with no automatic schema/hash tolerance. A future compatibility
table requires a reviewed contract change.

## Proposed negotiated messages

These interfaces are proposed API definitions, not implemented SDK signatures.
Runtime schemas are strict, bounded and derive the types; no separately maintained
TypeScript/JSON schema copies. House IDs are opaque server-configured strings;
protocol does not enumerate particular house integrations.

```ts
type HouseId = string;
type TabHandle = string; // Opaque; never a Chrome numeric tab ID.
type CatalogVersion = string; // sha256:<hex> as defined above.

interface ClientHello {
  type: 'hello';
  supportedProtocolVersions: number[];
  protocolPackageVersion: string;
  catalogVersion: CatalogVersion;
  clientVersion: string;
  installationId: string;
  profileEpoch: string;
  platform: string; // Display/availability hint, never authorization.
  capabilities: string[];
}
interface ServerHello {
  type: 'hello_ack';
  protocolVersion: number;
  protocolPackageVersion: string;
  catalogVersion: CatalogVersion;
  serverVersion: string;
  browserId: string; // Logical identity assigned by the server.
  connectionId: string; // New server UUID for this READY socket.
  house: HouseId; // Derived from verified deployment/credentials.
  capabilities: string[]; // Effective approved subset.
}
interface HelloReject {
  type: 'hello_reject';
  error: { code: string; message: string };
  supportedProtocolVersions?: number[];
}
interface ToolRequest {
  type: 'tool_request';
  id: string; // Unique server UUID, not the MCP JSON-RPC ID.
  sessionId: string;
  connectionId: string;
  tabHandle?: TabHandle;
  tool: string;
  args: Record<string, unknown>;
}
interface ToolResult {
  type: 'tool_result';
  id: string;
  sessionId: string;
  connectionId: string;
  house: HouseId;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}
interface SessionClose {
  type: 'session_close';
  sessionId: string;
  connectionId: string;
}
interface RequestCancel {
  type: 'request_cancel';
  id: string;
  sessionId: string;
  connectionId: string;
}
interface Heartbeat { type: 'heartbeat' }
interface HeartbeatAck { type: 'heartbeat_ack' }

negotiateVersion(serverVersions: readonly number[],
                clientVersions: readonly number[]): number | null;
```

`negotiateVersion` returns the greatest common supported integer without mutating
inputs; the wire schema rejects empty, duplicate, non-positive or oversized lists.
Proposed limits: 16 versions, 128 capability names, 128 UTF-8 bytes per identifier,
and 5 seconds for hello. Tool/response payload bounds must accommodate existing
screenshots and file operations; finalize those bounds from current fixtures
before enabling negotiated runtime, rather than impose a guessed low limit.

Success requires `ok:true` and no error; failure requires `ok:false` and error,
with no data. Results echo session and connection IDs and must match the pending
owner and actual socket. A payload's house never grants access. ClientHello must
not contain a requested authoritative house. Extra routing keys in `args` are
rejected/removed by the MCP projection before dispatch, not used as identity.

`session_close` cleans per-session extension state and never closes a shared
browser socket. On explicit reselection, send it to the previous connection before
opening a context on the new one. The first validated tool request creates that
connection's local session context. Socket loss removes its ephemeral session
contexts; local caps bound stale contexts if a close frame cannot be delivered.
`request_cancel` is best effort: prevent later steps and discard late replies;
it cannot promise reversal of side effects already performed. No automatic replay.

## Negotiation and extension state

Server: authenticated upgrade -> AWAITING_HELLO -> READY -> CLOSED.
Do not register/select a browser or dispatch tools before READY. The first
application frame must be hello. Choose maximum common wire version; verify the
catalog digest and the installation's authorization; ack once. Unknown required
capabilities never become permissions. Duplicate hello, malformed frames, legacy
frames, absent hello, incompatible versions or catalog mismatch reject visibly,
close, and emit no tool. Proposed private WS close codes: `4400` invalid protocol,
`4406` version/catalog mismatch, `4408` hello timeout. Rejections use stable codes
and bounded redacted messages; no raw token/query/payload in diagnostics.

Extension: DISCONNECTED -> CONNECTING -> NEGOTIATING -> READY; transient failures
enter RETRY_WAIT, explicit auth/protocol/catalog failures enter BLOCKED until
configuration changes or explicit retry. OPEN sends one hello and is not connected.
Heartbeat starts only after validated ack (proposed 20-second interval, compatible
with the existing Chrome 116 minimum). Connect settles once even if closed before
OPEN/ack. A failed negotiation preserves token, URL and installation UUID.

Every callback/operation captures its socket and local generation. Ignore stale
events; a completed operation writes only to its original still-READY socket.
Validate ack's version against the offered set, digest, authoritative identity and
schema; reject duplicate/out-of-state ack. The outer reconnect loop respects
BLOCKED and explicit disconnect. Clear timers, negotiated metadata and pending
operations on loss/reload; never persist READY as truth across worker restarts.
Status UI exposes negotiating/incompatible/auth-unconfirmed/transient errors,
sanitized endpoint and contract version; it must not invent a precise auth failure
when the browser supplies only an opaque failed upgrade.

## Identity, token migration and trust boundary

Three identities must stay separate:

1. `installationId`: persistent extension/profile hint. Migrate existing
   `ajb.connectionId` by reading it as the installation UUID, without regenerating
   tokens or silently overwriting configured values.
2. `browserId`: server-issued logical identity, continuity only after verified
   enrollment associates house, credential owner and installation.
3. `connectionId`: server-issued UUID per accepted negotiated socket; internal
   generation captures the physical socket. Client input cannot replace a live one.

House/principal come from trusted adapter configuration and verified credentials,
never `platform`, labels, query, tool args, `_meta` or an installation UUID alone.
An extension token and an MCP token may represent different principals: an injected
access policy explicitly authorizes the MCP client to use that browser owner.
Do not require matching raw tokens or infer access from matching UUIDs.

HTTP currently relies on a network/proxy boundary and does not intrinsically
authenticate MCP callers. Negotiated mode must make this boundary explicit:
either a real per-request verifier on POST/GET/DELETE, a verified assertion from
a trusted proxy which strips client headers, or a restricted single-house operator
endpoint with one documented operator principal. A free `X-House`/`X-User` header
is not verified identity. Multi-house/user exposure fails closed without a verifier
and ACL. MCP session IDs are routing state, never credentials; store and check
their owning principal/scope on every request. These requirements do not claim
that OAuth or new proxy configuration is implemented by this proposal.

Per-installation tokens can carry trusted owner/house/installation enrollment.
Existing token-store `connectionId` metadata was supplied at pairing and is not
proof of ownership. Preserve old records and require trusted re-enrollment or a
reviewed operator migration before treating them as authenticated identity.
Shared static legacy credentials do not prove which installation is reconnecting:
do not let a matching client UUID displace another socket or resume its bindings.
Such credentials require explicit enrollment for negotiated continuity; the old
service/rollback stays usable. Any token-store migration gets a separate reversible
PR, backup and authorization before rollout; no reset as a shortcut.

## MCP session binding and request ownership

Use SDK 1.30.1 handler `extra.sessionId`, `authInfo` and `signal` after transport
and credential verification. Stdio gets one internal UUID and operator principal
per server instance; it does not accept a client-supplied session identity.

```ts
interface SessionBinding {
  sessionId: string;
  browserId: string;
  connectionId: string;
  house: HouseId;
}
interface ExecutionTarget extends SessionBinding {
  generation: number;
  socket: unknown; // Actual captured WS, internal only.
}
```

Share the broker, not mutable selection. List only authorized READY browsers;
`selected` is per session. Preserve the MCP `connection` selector but make selection
persistent for that session. Remove selector metadata before invoking tool schemas.
An unbound session gets: zero candidates -> `browser_unavailable`; one -> atomic
auto-bind; multiple -> `browser_selection_required`, zero action. Never choose by
last activity, arrival order or another session. Unknown and unauthorized explicit
IDs share `browser_not_found` to avoid enumeration.

Changing selection while calls are in flight returns `session_busy`; reserve/bind
atomically before awaiting. Concurrent calls on the same binding may proceed subject
to existing tool/Copilot traffic gates. Bound browser loss fails its pending calls
immediately; it never falls back to a different remaining browser. After trusted
re-enrollment/reconnect of the same logical browser, a subsequent call may refresh
to its new connection generation after hello; pending calls are never replayed.
This continuity does not apply to shared-token UUID claims. A changed profile epoch
invalidates old tab handles.

Pending requests store wire UUID, MCP session/principal, socket, generation,
connection and house, deadline and AbortSignal cleanup. Insert before send; handle
send throws/callback failure. Accept only a valid result from that actual READY
socket with all expected IDs and house while owner session is open. Wrong-sender
results do not consume the legitimate pending entry; duplicate/late/unknown results
are discarded. Timeout, abort, socket loss and response race settle exactly once,
removing timers/listeners/in-flight slots. Cancellation/timeout never proves an
already sent action did not execute and never triggers automatic retry.

DELETE, logical MCP close, expiry, revocation and shutdown use one idempotent
per-session cleanup. An SSE connection ending is not logical session closure.
Do not close the shared broker or another session. An authenticated initial
InitializeRequest has no session header: create its transport/session and return
the assigned ID. Subsequent requests requiring that session: missing ID ->400,
unknown/expired ->404 (the client may initialize anew without the old ID).
Invalid Origin ->403; auth failures ->401/403 as appropriate.
Stdio EOF/SIGINT/SIGTERM close asynchronously before process exit with a bounded
deadline; `process.on('exit', async ...)` is insufficient. Proposed idle expiry
30 minutes and max sessions/contexts are operator-configurable, with active work
protected; freeze exact resource limits during implementation review.

## Tabs and optional capabilities

The wider M1B plan requires opaque handles scoped to session, authorized browser,
profile epoch and live tab incarnation. A handle navigates with its tab, is
invalidated on close/profile restart, cannot be guessed from numeric tabId, and
cannot resolve in another session/profile. The extension carries a validated
explicit target into handlers; it never falls back to a shared active/global tab.
Tabless and tab-creating tools are described explicitly in the catalog.

Handle continuity across ordinary WS reconnect is required while identity/epoch
and the tab incarnation are still proven. Worker restart loses globals: persist
only session-local handle metadata in `chrome.storage.session`, validate live tabs,
and invalidate conservatively where incarnation cannot be proved. A numeric
`tabs.get(tabId)` alone is not proof that a missed close/reuse did not occur.
The exact incarnation/recovery algorithm is a separate M1B implementation design
gate with Oppo; this proposal does not claim to solve CDP scoping or invisible
worker lifecycle. If conservative recovery conflicts with required continuity,
agree that contract explicitly before shipping handles.

Catalog capabilities include optional `op-safe/browser_fillsecret` and operations
requiring Linux file-descriptor guarantees. No implementation ->
`capability_unavailable` before action; advertised but failed -> distinct execution
error. Client claims do not elevate permissions. Secret-provider/execFile adapters
belong outside core, with no secrets in prompts/logs/chats. Preserve default denial
of `browser_run_code_unsafe`, pinned-directory protections and Copilot lease/gate.
On macOS, unavailable safe filesystem guarantees remain unavailable, with no
insecure fallback. Actual house adapter work and CDP allowlists remain M2.

## Compatibility and errors

| Pair / condition | Required outcome |
| --- | --- |
| New/new, common version and exact catalog | READY after authenticated hello, real tool with session target |
| Several common versions | Greatest common integer; no input-order dependency |
| Disjoint versions / unknown catalog | Visible rejection, CLOSED/BLOCKED, zero actions |
| Old extension -> negotiated server | `hello_required` or `hello_timeout`; no legacy action |
| New extension -> old server | Local incompatible/hello-timeout error; reject early legacy tools; no fallback |
| Old extension -> explicitly enabled legacy service | Old wire guards pass; no claim of new negotiation/ownership guarantees |
| Existing old/old installation | Unchanged until separate authorized rollout |
| Wrong credential / foreign response / foreign tab | Rejected, no cross-owner execution or pending settlement |
| Missing capability | `capability_unavailable`; no degraded operation |

Stable errors: `protocol_version_mismatch`, `catalog_version_mismatch`,
`hello_required`, `hello_timeout`, `invalid_message`, `browser_selection_required`,
`browser_unavailable`, `browser_not_found`, `browser_disconnected`, `session_busy`,
`session_closed`, `request_cancelled`, `request_timeout`, `tab_handle_invalid`,
`capability_unavailable`, `response_correlation_mismatch`. Error messages are bounded,
redacted and visible in MCP text as well as structured content where appropriate.

Keep both legacy wire suites under an explicitly legacy fixture/adapter. New hello
tests coexist; changing those old assertions into new-wire assertions would erase
the M1A regression guarantee agreed in Oppo message 1400. Temporary legacy access
has only its documented old security guarantees and is not exposed multi-house.

## Agreement and implementation boundaries

Oppo is asked to agree/amend: endpoint transition and legacy retirement; package
namespace/version and TGZ provenance; hello additions and echoed IDs; trusted MCP
boundary/ACL and enrollment migration; selector/reconnect semantics; resource
limits/close codes; handle recovery proof. These are proposals, not already accepted
runtime contracts. Agreement should refer to the two exact design PR heads.

Split implementation into contract/negotiation, identity+session routing, and
handles+capability projections. Each pair of implementation PRs must preserve old
tests, consume the same artifact and pass the minimum compatibility matrix; M5
later expands the matrix rather than postpones incompatible rejection. Infra,
package publishing, updater, client registry changes and fleet rollout are separate
phases. Codex has delegated technical merge authority; the authorized writer
executes exact-head decisions when product push access is unavailable. Do not
bypass branch protection. No additional Jordi approval is inferred for routine
technical merges; explicit deployment gates still apply.

## Sources and verification limits

Research checked the installed MCP TypeScript SDK **1.30.1**, rather than assuming
v2 examples from mixed documentation. Official sources consulted through LazyMCP:

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices
- https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility
- https://docs.npmjs.com/cli/v11/commands/npm-install
- https://docs.npmjs.com/cli/v11/commands/npm-pack

Context7 SDK v1.x, npm CLI and Vite documentation supplemented source inspection.
Some retrieved SDK examples concerned main/v2, and npm web results concerned older
CLI versions: they are not evidence of 1.30.1/new CLI signatures. Implementation
must pin and verify its actual toolchain. This design PR runs document/diff checks,
not runtime tests; the M1A green suites are baseline evidence, not M1B verification.
