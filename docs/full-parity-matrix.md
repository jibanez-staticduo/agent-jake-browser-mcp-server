# Full Pocharlies server parity

Source baselines: StaticDuo `d237e7daa333b0bf629ccf0ec5ea7a9da6cbfe9d`; Pocharlies `19ebe69694343821f2ff5179cf0cf05de3140772`. A real merge keeps both histories. The complete upstream tree is adopted first, with the reviewed overlays below. Runtime truth and deployment are separate from this source report.

## MCP catalog

Every tool declared by upstream is retained, including optional tools.

| Tool | Status | Adaptation |
| --- | --- | --- |
| `browser_list_connections` | Retained | Upstream implementation; optional gates below |
| `browser_click` | Retained | Upstream implementation; optional gates below |
| `browser_type` | Retained | Upstream implementation; optional gates below |
| `browser_hover` | Retained | Upstream implementation; optional gates below |
| `browser_drag` | Retained | Upstream implementation; optional gates below |
| `browser_select_option` | Retained | Upstream implementation; optional gates below |
| `browser_press_key` | Retained | Upstream implementation; optional gates below |
| `browser_upload_file` | Retained | Upstream implementation; optional gates below |
| `browser_drop` | Retained | Upstream implementation; optional gates below |
| `browser_fill_form` | Retained | Upstream implementation; optional gates below |
| `browser_fill_secret` | Retained | Upstream implementation; optional gates below |
| `browser_save_secret` | Retained | Upstream implementation; optional gates below |
| `browser_passkey` | Retained | Upstream implementation; optional gates below |
| `browser_navigate` | Retained | Upstream implementation; optional gates below |
| `browser_go_back` | Retained | Upstream implementation; optional gates below |
| `browser_go_forward` | Retained | Upstream implementation; optional gates below |
| `browser_reload` | Retained | Upstream implementation; optional gates below |
| `delegar` | Retained | Upstream implementation; optional gates below |
| `delegar_estado` | Retained | Upstream implementation; optional gates below |
| `browser_get_text` | Retained | Upstream implementation; optional gates below |
| `browser_get_attribute` | Retained | Upstream implementation; optional gates below |
| `browser_is_visible` | Retained | Upstream implementation; optional gates below |
| `browser_wait_for_element` | Retained | Upstream implementation; optional gates below |
| `browser_highlight` | Retained | Upstream implementation; optional gates below |
| `browser_snapshot` | Retained | Upstream implementation; optional gates below |
| `browser_state` | Retained | Upstream implementation; optional gates below |
| `browser_find` | Retained | Upstream implementation; optional gates below |
| `browser_new_tab` | Retained | Upstream implementation; optional gates below |
| `browser_list_tabs` | Retained | Upstream implementation; optional gates below |
| `browser_find_tab` | Retained | Upstream implementation; optional gates below |
| `browser_switch_tab` | Retained | Upstream implementation; optional gates below |
| `browser_claim_tab` | Retained | Upstream implementation; optional gates below |
| `browser_send_to_back` | Retained | Upstream implementation; optional gates below |
| `browser_close_tab` | Retained | Upstream implementation; optional gates below |
| `browser_wait` | Retained | Upstream implementation; optional gates below |
| `browser_screenshot` | Retained | Upstream implementation; optional gates below |
| `browser_get_console_logs` | Retained | Upstream implementation; optional gates below |
| `browser_network_requests` | Retained | Upstream implementation; optional gates below |
| `browser_network_request` | Retained | Upstream implementation; optional gates below |
| `browser_run_code_unsafe` | Retained | Upstream implementation; optional gates below |
| `browser_evaluate` | Retained | Upstream implementation; optional gates below |
| `browser_resize_viewport` | Retained | Upstream implementation; optional gates below |
| `browser_get_html` | Retained | Upstream implementation; optional gates below |
| `browser_iframe_eval` | Retained | Upstream implementation; optional gates below |
| `browser_iframe_click` | Retained | Upstream implementation; optional gates below |
| `browser_pdf` | Retained | Upstream implementation; optional gates below |

## Product behavior and safety overlays

| Capability | Result and evidence |
| --- | --- |
| Stdio MCP, HTTP streamable MCP | Native upstream behavior retained; both compiled as dist/index.js and dist/http-server.js; stdio/HTTP integration tests |
| Browser choice | Connection labels, configured defaults and sticky per-session selection retained |
| Pairing/token auth | Upstream stores, one-use pairing, handshake authorization, CORS retained |
| IP provenance and page labels | Own proxy allowlist/authenticated proxy policy, client/peer IP source, textContent rendering retained; client-ip/http-pages tests |
| WebSocket requests | Upstream request/socket/connection binding retained plus own UUID epoch and call snapshot; stale/foreign socket tests |
| Session tabs/windows | Upstream windowPerSession, lazy background tab, explicit target, live claim validation retained; own closed-session guards and epoch invalidation added |
| Cleanup | Upstream tab/window capabilities and echo checks retained; own participants, inflight activity, closing claims, retry and resweep guards; ownership and cleanup race tests |
| New tab response | Current extension tab.id validated; malformed success never reported as success |
| Fill secret | Default OFF, literal AGENT_BROWSER_FILL_SECRET_ENABLED=true gates catalog+handler; Connect/service-account reader can be injected; sanitized errors; typed=true and verified=true required; no length/reference result |
| Save secret | Upstream Connect-only write token/vault-ID allowlist, explicit overwrite, OTP validation, RE2JS extraction and sanitized result retained unchanged |
| Passkeys | Upstream use/enroll and ceremony report validation retained unchanged; no real credentials enabled in verification |
| Paseo plugins | Upstream external tools, no browser arguments, upstream timeouts/configuration retained unchanged |
| Downloads | /download patches config.json only for initial instance setup; /download/latest.json retained; /download/artifact.zip serves published signed ZIP unchanged |
| Published artifacts | BROWSER_EXTENSION_DIR contains latest.json and agent-jake-browser-extension.zip; paths read on each request for atomic directory/symlink promotion |
| Runtime instances | BROWSER_PUBLIC_WS_URL, BROWSER_PUBLIC_ORIGIN, BROWSER_WS_PATH configure Main/Ari/Fedora, including Ari /browser-ws; no instance host embedded in source |
| Native boundaries | Pinned-directory upload/output protections, frame tags, CDP routing, screenshots/PDF, batch/utility behavior retained from upstream |
| Docker | Node 22, compiled HTTP without tsx runtime loader, checksum-verified native-architecture op installer, read-only runtime probe |
| Layout | Flat upstream src retained under user architecture-agnostic authorization; prior empty house wrappers removed; public compiled CLI contracts retained |

## Acceptance and limitations

Node 22 typecheck, build, full Vitest suite, compiled HTTP/stdio contract and Docker read-only probe are the local gates. CI uses this fork's configurable runner instead of an upstream-only ARC label. scripts/check-deltas.sh still checks upstream product invariants against typed HTTP source.

Browser MV3 UI, native passkey ceremonies, a real Connect write, Paseo execution and the signed installer on a user's machine require their respective external environments. Local fakes are protocol evidence, not proof of those external outcomes. Fill and save remain disabled without explicit runtime configuration. No production credentials, deployment or remote push are part of this implementation.

## Verified candidate (2026-10-17)

- Node 22.22.2: clean npm ci, typecheck, build; 423/423 Vitest tests in 30 files.
- All fork delta checks pass. Production dependency audit: zero vulnerabilities; full audit retains one low esbuild development-server advisory on Windows.
- Local Docker image: sha256:a7146481a582c074705005d99701b48755f75f38f9199be94ae899fe504a1740.
- Docker probe: read-only root, network disabled, tmpfs /data and /tmp, signed bundle read-only mount; healthcheck healthy. HTTP health, Ari /browser-ws public URL, own pairing origin, raw artifact byte equality, 42 default tools and fill/save disabled all pass.
- External browser/native passkey/Connect write/Paseo execution remain external validation; no real secrets used.
