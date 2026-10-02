# Browser Harness M1B implementation plan (A-F resolution recorded)

Contract: [shared design](../specs/2026-10-01-browser-harness-m1b-design.md).
This PR is documentation only. Checkboxes describe future implementation, not
completed work. Pair with the canonical extension design PR against `master`.

## Gate 0: record and deliver the frozen contract resolution

- [x] Codex resolves A-F in the shared spec (2026-10-02), including hash versus
  signature, 32 MiB/message and default conservative handle invalidation.
- [ ] Publish paired updated design heads/comments; Marlin relays decisions to Oppo.
- [ ] Implementation PRs record those exact design heads and concrete enrollment,
  resource-cap and optional positive handle-recovery designs before enabling them.
- [ ] Keep canonical source branches and deployed product/infra branches distinct.
  No new image rollout without the separately recorded explicit Dani OK.

## M1B.1: protocol and negotiation pair

Server ownership: `packages/protocol`, workspace manifests/lock, negotiated WS
dispatcher and protocol tests. Extension ownership: vendored artifact/provenance,
WS client state machine, runtime status UI and tests. Coordinate the exact artifact
before changing consumers; source does not include house integrations.

- [ ] Add browser-pure schemas/types/catalog/serializer/version helper. Test exact
  maximum intersection, invalid lists, catalog hash and strict message schemas.
- [ ] Generate one reviewed TGZ from exact source; verify contents/provenance/hash
  before install and in both CIs. Execute imports under Node and Vite/MV3.
  Pack generated catalogVersion/wire metadata in package.json and verify offline
  against packed descriptors, exports and provenance; mutate each separately in
  tests to prove stale/tampered data fails. No hash-only claim of publisher signing.
- [ ] Add explicit negotiated endpoint; no guessed URL rewriting or auto downgrade.
  Keep executable M1A guards on an isolated legacy fixture/adapter.
- [ ] Require authenticated hello before registry READY. Test absent/old/malformed/
  duplicate hello, incompatible versions/catalog and early tools => zero actions.
- [ ] Extension connect resolves after validated ack; generation-bound callbacks
  and responses; permanent BLOCKED versus transient retry; cleanup on every exit.
- [ ] Keep configured domain/URL, token, explicit empty values, installation UUID,
  storage privacy, pairing reload and all Copilot protection tests passing.
- [ ] Enforce 32 MiB = 33,554,432 bytes per complete uncompressed UTF-8 JSON message
  bidirectionally, before parse/send, with bounded server reassembly/decompression.
  Test exact bound and bound+1, non-ASCII byte counts, fragmentation/compression
  bypass attempts, send/pending cleanup and oversize completed-result error without
  replay. Execute extension application check; document browser preallocation limit.
- [ ] Measure serialized real screenshot/file/tool fixtures including envelope and
  base64/JSON-escaping overhead, including 10 MiB total drop files, eight files
  and 1 MiB MIME data. HTTP ZIP downloads are not WS fixtures. A required workflow
  exceeding the bound needs a reviewed transport/contract change before delivery.

Acceptance: real WS positive/negative handshake tests and the old wire suites pass.
Do not enable this mode in an installed service until M1B.2 ownership gates pass.

## M1B.2: trusted identity and MCP session routing pair

Server ownership: injected principal/access policy, token enrollment migration
proposal, connection registry, pending correlation, HTTP/stdio context and cleanup.
Extension ownership: per-session request context, echoed result identity,
session-close/cancel handling and stale-operation protection.

- [ ] Make HTTP boundary explicit and verify POST/GET/DELETE before session lookup.
  Test foreign session ID, forged house/platform, proxy assertions and revocation.
  Test authenticated initialize without session header creates a new session;
  subsequent missing ID is 400, expired/unknown is 404, then fresh initialize works.
- [ ] Separate installation/browser/live-connection identity; no live replacement
  or continuity based on an arbitrary UUID/shared static token. Preserve token data;
  migration needs its own reversible PR and operator evidence.
  Mandatory adversarial test: authenticated shared-token client copies another
  installation UUID and cannot replace its socket, obtain its binding, settle its
  pending call or resume its browser identity. Include same-house and cross-house.
- [ ] Derive session from verified SDK transport, with internal UUID for stdio.
  Atomic binding: 0 unavailable / 1 auto-select / many selection-required.
- [ ] `connection` selects persistently for the current session; no global default,
  foreign enumeration, fallback after disconnect or reselection during in-flight.
- [ ] Capture UUID+session+socket+generation+house pending owner; reject wrong sender,
  late/duplicate/mismatched results without consuming another request's entry.
- [ ] Abort/timeout/send failure/disconnect settle once and clean resources. No
  replay. DELETE closes one logical session; SSE loss does not close it or broker.
- [ ] Test two HTTP MCP clients and independent stdio instances with real sockets,
  identical JSON-RPC IDs, reversed replies, reconnect and concurrent selection.
- [ ] Test session-close/reselection releases extension context; cancel stops future
  steps without promising undo. Existing Copilot lease is preserved.

Acceptance: one client's selection/replies cannot act as another's; all ownership
and cleanup cases pass. A trusted single-house boundary is documented honestly;
multi-house exposure remains disabled until verifier/ACL tests pass.

## M1B.3: opaque targets and catalog capability projections

- [ ] Freeze and implement live-tab incarnation/recovery algorithm with Oppo first.
  Numeric Chrome tab IDs alone are not cross-session authority or recovery proof.
  Default invalidation is already fixed: worker restart or reconnect without
  positive incarnation proof invalidates handles. Enable continuity only when tests
  prove same session/browser/epoch/live tab, including missed close and ID reuse.
- [ ] Handle navigate/close/profile restart, ordinary reconnect, worker sleep/wake,
  two profiles sharing numeric IDs, foreign handle and missing explicit target.
  Pass target through handlers; no active/global fallback.
- [ ] Generate HTTP/stdio and Copilot browser schemas/risk from the one catalog;
  local Copilot meta tools stay local. Test exact name/schema parity and subsets.
- [ ] Optional OP-safe/Linux capabilities are reported honestly; absent errors differ
  from backend failure. Preserve unsafe denial, pinned directories and redaction.
  Do not implement house providers/CDP allowlists here as hidden core integrations.
- [ ] Test never negotiated -> capability_unavailable, lost after same authorized
  binding reconnect -> capability_revoked, restored valid ack -> normal checks;
  reselection/new session resets history and cannot inherit another browser's access.

Acceptance: the paired build passes real browser targeting and capability-negative
cases under both compositions. Platform cases not tested locally are identified
for QA, not reported as verified.

## Validation and review

Server commands after implementation: `npm ci`, `npm run typecheck`, `npm test`
(includes build), `npm run test:contract`. Extension: `npm ci`, `npm run typecheck`,
`npm run test:unit`, `npm run build`, selected Playwright MV3 tests. Add negotiated
contract/compatibility commands/workflow in the relevant implementation PRs rather
than assume a nonexistent extension script.

Minimum real pair matrix before runtime delivery: new/new valid tool, maximum
intersection, disjoint versions, catalog mismatch, old/new in both directions,
early legacy tool rejection, missing hello, wrong credentials, cross-socket reply,
multiple browsers/session selection, session closure/cancellation, missing
capability, stale socket completion and tab ownership. Use synthetic credentials,
loopback fixture endpoints and exact artifact SHAs/hashes. No production tokens.
Keep original legacy assertions unchanged and execute them in explicit legacy mode.

Perform one independent review proportional to changed trust boundaries; fix
concrete security/regression defects, then rerun their relevant tests and candidate
checks. Record source SHAs, artifact hash, commands/results, both CI URLs, local
browser version and remaining external QA cases. Passing baseline unit tests or
HTTP health alone does not verify negotiated routing.

Document-only acceptance now: clean diff, links consistent, no changed runtime/
lock/manifests, agreement questions explicit, paired proposal PRs published and
Marlin relay verified. No runtime suite is claimed for these proposal PRs.

## Subsequent phases

Before M1B runtime: separate small core PR for new_tab ID mismatch, with actual
extension response/missing-ID tests and background-tab behavior preserved. Ask Oppo
for repository/full candidate SHA or PR; do not claim the four unlocated short SHAs
are integrated. No fix, merge or rollout is executed by this docs-only PR.

M2: house integrations, CDP scope and migration. M3: updater/build/distribution in
infrastructure. M4: registry and separately authorized sequential Main/ARI/Fedora
rollout with preserved stores/URLs and compatible rollback. M5: extended automated
compatibility/required checks. Rollout cannot be inferred from design approval or
product merge; the explicit image-deployment gate remains active.

Legacy retirement in M4 occurs only after authorized migration of both houses and
14 full days' notice in topic 374; the house with remaining legacy clients owns the
inventory/removal. Record earliest date and delayed-client owner, then remove at
the later of verified completion and notice date. Legacy regression fixtures remain.
