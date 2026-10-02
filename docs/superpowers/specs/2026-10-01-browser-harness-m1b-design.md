# Browser Harness M1B: shared contract and A-F resolution

Date: 2026-10-01; resolution updated 2026-10-02. Status: Codex A-F contract
resolution frozen for implementation planning; publish/relay the exact paired heads.
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

Retirement is mandatory once both conditions are met: the separately authorized
rollout has migrated the clients of both houses (StaticDuo Main/ARI/Fedora and
Pocharlies NAS), and at least 14 full days have passed since the retirement notice
in topic 374. Each house still using legacy owns its client inventory, migration
and endpoint removal. The notice records the earliest removal date and outstanding
clients; remove legacy at the later of that date and verified completion of both
houses' migration, without an indefinite operator opt-out. If migration is delayed,
report the remaining clients and owner in the same thread. Neither the notice nor
this retirement rule authorizes rollout, credential resets or silent downgrade.
Keep executable legacy fixtures even after the deployed legacy endpoint is removed.

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

The packed protocol's `package.json` contains generated `browserHarnessProtocol`
metadata: `supportedProtocolVersions` and `catalogVersion`. The packed descriptor
data and exported digest come from that same build. Offline verification recomputes
the digest from the packed descriptors and checks it against the packed manifest,
exports and pinned provenance, before connecting or installing consumers. Tampered
descriptors, a stale manifest or a mismatched TGZ hash fail verification. This is
integrity tied to the separately verified source/TGZ pin, not a cryptographic
publisher signature: a hash alone cannot authenticate a malicious replacement of
both descriptors and metadata. No new signing-key service is introduced in M1B.

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
Contract limits: 16 versions, 128 capability names, 128 UTF-8 bytes per identifier,
and 5 seconds for hello. The negotiated payload limit is **32 MiB = 33,554,432 bytes**
per complete, reassembled, uncompressed UTF-8 JSON WS message, in either direction,
including the envelope and encoded image/file data. This amends the proposed
8 MB ceiling rather than silently change its unit. Existing browser_drop admits
10 MiB raw files, producing 13,981,016 base64 bytes before envelope, plus 1 MiB
raw MIME data which may expand with JSON escaping. 8 MiB would reject that supported
file budget. The 32 MiB bound accommodates that known encoding budget and reduces
the current server default 100 MiB inbound allowance. It does not establish that
all unbounded screenshot/PDF/metadata inputs fit; measure complete messages.
Synthetic negotiated JSON.stringify envelopes with the full 10 MiB file budget
and maximal NUL MIME value (1 MiB combined type/value, sixfold JSON escaping)
measure 20,272,748 bytes for one file and 20,273,260 bytes for eight files with
representative metadata. These measurements explain the selected bound, not a
universal metadata bound or a browser runtime test. Fragmenting
or compressing a message does not increase the permitted logical size. Check size
before JSON parsing on receipt and before enqueue/send on transmission; server
transport limits also bound reassembly/decompression. The browser transport may
allocate the received message before JS can inspect it, so do not claim preallocation
protection on the extension merely from its application-size check.

Inbound excess closes with standard WS code `1009`; local oversize requests fail
with `payload_too_large` before send/action and clean pending state. If a completed
action produces an oversize result, send a bounded `payload_too_large` error instead
of truncating/replaying it; this does not undo the completed action. No automatic
retry, fallback or per-message limit override. A future limit change must update
both protocol consumers and their reviewed compatibility fixtures.

Before negotiated runtime delivery, measure real serialized screenshot/file/tool
fixtures and execute exact-limit, limit+1, multibyte UTF-8, fragmented and compressed
message tests in both directions. A ZIP downloaded over HTTP is not a WS payload
fixture and cannot establish this limit's compatibility. This design sets the
limit; it does not claim the existing largest browser payloads have been measured
or that the new bound has passed runtime QA. Oversize supported workflows require
a separate reviewed transport design or contract revision, not a silent bypass.

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

Handle invalidation is conservative by default: without positive proof of the
same authorized session/browser, profile epoch and live tab incarnation, the old
handle is dead (`tab_handle_invalid`). Ordinary reconnect continuity is enabled
only when a real test demonstrates that proof, including missed close/reuse cases.
No worker-restart continuity is promised by default. Worker restart loses globals:
persist only session-local handle metadata in `chrome.storage.session`, validate live tabs,
and invalidate conservatively where incarnation cannot be proved. A numeric
`tabs.get(tabId)` alone is not proof that a missed close/reuse did not occur.
The exact incarnation/recovery algorithm is a separate M1B implementation design
gate with Oppo; this resolution fixes conservative invalidation as the contract
until a positively proven recovery algorithm passes its gate. It does not claim
to solve CDP scoping or invisible worker lifecycle. Validating a numeric ID or
finding session-storage metadata alone never enables continuity.

Catalog capabilities include optional `op-safe/browser_fillsecret` and operations
requiring Linux file-descriptor guarantees. No implementation ->
`capability_unavailable` before action; advertised but failed -> distinct execution
error. For a retained authenticated binding to the same logical browser, record
the effective capabilities previously negotiated for that session/browser. If a
required capability was available there but is absent after a verified reconnect,
the attempted tool returns `capability_revoked`; if it was never available, return
`capability_unavailable`. Both fail before dispatch and with no degraded operation.
If legitimately restored in a later ack, the tool may run after normal authorization
checks. A new session or explicit selection of another browser resets that history;
the old browser's capabilities never authorize the new one. History is server-owned,
not client claims, and capability_revoked does not replace auth/revocation errors.
Disconnected browsers still return browser_disconnected until a valid READY ack.
Client claims do not elevate permissions. Secret-provider/execFile adapters
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
| Capability lost on same verified binding after reconnect | `capability_revoked`; no action; restoration requires a valid later ack |
| Oversize negotiated message | 1009 inbound / `payload_too_large` local; no truncation or replay |

Stable errors: `protocol_version_mismatch`, `catalog_version_mismatch`,
`hello_required`, `hello_timeout`, `invalid_message`, `browser_selection_required`,
`browser_unavailable`, `browser_not_found`, `browser_disconnected`, `session_busy`,
`session_closed`, `request_cancelled`, `request_timeout`, `tab_handle_invalid`,
`capability_unavailable`, `capability_revoked`, `payload_too_large`,
`response_correlation_mismatch`. Error messages are bounded,
redacted and visible in MCP text as well as structured content where appropriate.

Keep both legacy wire suites under an explicitly legacy fixture/adapter. New hello
tests coexist; changing those old assertions into new-wire assertions would erase
the M1A regression guarantee agreed in Oppo message 1400. Temporary legacy access
has only its documented old security guarantees and is not exposed multi-house.

## Codex resolution of Oppo amendments A-F (2026-10-02)

Oppo message 1413 accepts the proposal as a base and permits documented acceptance
or reasoned amendment of A-F. His later clarification accepts hash versus signature
and measuring actual WS payloads. Canonical destinations remain Pocharlies `master`
under INFRA-302; the older topic 315 proposal does not change those destinations.

| Item | Decision and reason |
| --- | --- |
| A - legacy retirement | Accept: both authorized house migrations complete, at least 14 days' notice in topic 374, each house with legacy clients owns removal; no permanent exception |
| B - packaged catalog hash | Accept offline manifest/descriptor verification; amend the word signed to integrity-checked, since no signing key/trust chain exists and a digest is not a publisher signature |
| C - capability_revoked | Accept: distinguish never available from lost on the same authenticated session/browser binding, with explicit restoration/reset semantics |
| D - MCP trust boundary | Accept: installationId remains non-authoritative; make shared-token+UUID impersonation/live replacement/reconnect tests mandatory before negotiated enablement |
| E - payload limit | Amend 8 MB to 32 MiB (33,554,432 bytes): a supported 10 MiB drop already exceeds 13 MiB in base64; limit whole uncompressed UTF-8 JSON messages bidirectionally, with real WS boundary fixtures, not HTTP ZIP evidence |
| F - handle recovery | Accept: default invalidate without positive proof; enable continuity only after tests prove session/browser/epoch/incarnation and missed close/reuse safety |

These decisions freeze the contract policies for implementation planning at the
published paired heads. Enrollment implementation/migration, resource caps other
than the fixed payload/hello bounds, and the optional positive handle-recovery
algorithm still need their concrete implementation designs/tests. Their absence
does not permit weaker identity or guessed continuity. This freeze is not a merge
decision, implemented runtime verification or permission to roll out an image.

The existing new_tab result mismatch is separate from negotiation and will receive
a small core bug-fix PR before M1B runtime work, rather than hide in protocol changes.
Request the original repository/full SHA or reviewable PR from Oppo if available;
the four historical short SHAs are currently unverified. Test the actual extension
`{tab:{id}}` result and malformed/missing-ID failure; do not make up an ID or undo
the default background-tab behavior. No bug-fix implementation is part of this PR.

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
