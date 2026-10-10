# Browser Harness M1A server inventory

This extraction starts from StaticDuo server
`846dab66c8937b91b2995c7da47e2361d602f577`. M0 inspected Pocharlies server
master `a1d7e34977798698054d50291c25a4ba949930f9`, an ancestor with 27 fewer
commits. The candidate extension reference is
`97f1a75fec6339a78b4fd32ee5a3db7ee77c95e2`; this server change does not alter
the extension. These are source references, not deployment claims.

## Product layout

| Before | After |
| --- | --- |
| `src/` shared tools, auth, transport, utilities | `packages/core/src/`, preserving modules |
| `src/index.ts` | `packages/core/src/cli/stdio.ts` |
| `http-server.js` | `packages/core/src/http/server.ts`, `http/pages.ts`, `cli/http.ts` |
| Product `tests/*.test.ts` | `packages/core/tests/` |
| `tests/e2e.test.ts` | `tests/integration/e2e.test.ts` |
| Root `dist/index.js` | Compatibility wrapper for the core stdio entrypoint |
| Root `dist/http-server.js` | Compatibility wrapper for the core HTTP entrypoint |

The source movement is a separate commit with 100% rename similarity. Workspace
wiring and HTTP JavaScript to TypeScript conversion have separate commits.
The root owns the sole lockfile and exposes the existing npm commands.
`@agent-jake-browser/core` exports factories and shared product functions;
importing it starts no listeners. Its `./stdio` and `./http` subpaths are
executable entrypoints. Each house package exposes only identity and the same
core factories; no tools, domains, tokens or deployment configuration are copied.

## Infrastructure handoff

The principal confirmed an exact copy from the base SHA into StaticDuo's
`nas-docker/mcp/agent-jake-browser/`, with source hashes in
`migration-source.json`, before these files were removed from this product:
`Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `healthcheck.js`,
`deploy/k8s/` (nine files), and `tests/deploy-k8s.test.ts`.
The infrastructure recipe stages a product Git archive plus its infrastructure
overlay. Deployment, image publication and runtime secrets remain outside core.
The infrastructure test scans `packages/core/src/`, including typed HTTP.

## Verification and boundaries

The M0 baseline has 82 tests: 73 product tests and 9 infrastructure tests.
The extracted product has those same 73 tests plus 3 entrypoint tests, for 76.
HTTP tests start the compiled HTTP process and cover pairing, token auth,
`tools/list`, ZIP URL injection and independent browser routing. The added tests
import core and both houses in a child process that must exit naturally, and
exercise stdio `initialize` and `tools/list` using the existing CLI arguments,
and verify loopback binding for an empty HTTP host value plus clean shutdown.

Browser E2E accepts `BROWSER_EXTENSION_PATH` pointing to a pinned unpacked
artifact, defaulting to `./test-artifacts/extension`. It no longer requires a
neighboring checkout. Real Chrome/MV3 and Copilot validation remains a separate
integration check; passing simulated browser tests does not prove it.

M1A retains the current wire format, port 8765, environment configuration,
multi-browser selection, pairing/token storage, ZIP behavior and pinned-directory
protections. It adds no new binding, negotiation or capabilities protocol.
`new_tab` changes remain M2. No merge or deployment is part of this extraction.

