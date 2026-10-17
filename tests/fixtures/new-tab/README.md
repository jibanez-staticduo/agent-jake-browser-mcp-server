# new_tab producer fixtures

Producer: https://github.com/pocharlies/agent-jake-browser-mcp-extension
Canonical source: cc3b59204f1864c4cff2c9be1f7cc8bcf83d6dc0.

Captured on 2026-10-02 using the real createToolHandlers dispatcher, its Zod
schemas, and TabManager.createTab. Both fixtures passed an explicit local
producer probe. All 21 imported extension source files matched the canonical
commit byte for byte; the parent independently repeated that comparison.

Chrome tabs.create returns a controlled tab (id 42, URL https://example.test/,
title Example, active copied from the create arguments). Chrome storage is a
stub. waitForTabLoad is stubbed; connectTab records the ID and sets the manager's
connectedTabId. No handler, schema, createTab or envelope code is replaced.
The probe verifies Chrome create active:false for an omitted switchTo and
active:true when requested, and the wait/connect calls with ID 42.

The dispatcher receives {id:"new-tab-default",type:"browser_new_tab",
payload:{url:"https://example.test/"}} or id:"new-tab-foreground" with
switchTo:true. Responses are normalized with JSON.stringify/JSON.parse.
The committed files are those serialized responses, not hand-built envelopes.

The local Node probe used server-lock esbuild and Zod 4.3.5 (matching the producer
lock), with alias @ to the pinned extension src and import.meta.env defined as
{} for the Vite module's local defaults. Normal server tests read these local
JSON files only: no sibling checkout, network fetch or moving branch dependency.
To recapture, execute the producer dispatcher with the controlled Chrome and
connection stubs described here, and compare the complete envelopes to these
files. Do not replace the producer with a handwritten {tab:...} handler.

Fixture SHA-256:
- default.json: 56b5a960c630b7cde71a2bb243fa0d6de92121c15a39aa16f9c199948fc530a1
- foreground.json: dbc957ae3a747b8c3de7070c20099adf88a0233dfe2fc4cc3b609743e38ae37c

The server wire test substitutes only each fixture's correlation ID for the
live request ID. Real loopback WS framing is verified there. This producer probe
does not verify a real browser, tab load, CDP attachment or deployed service.
