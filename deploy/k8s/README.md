# Running the server on Kubernetes

The normal install still works exactly as before: `npm install && npm run build`,
and your MCP client spawns `dist/index.js` over stdio. Nothing here changes it.

This directory is for the other shape — the server running as a pod, with the
browser somewhere else entirely:

```
  agents in the cluster ──HTTP /mcp──►  ┌──────────────┐
                                        │   the pod    │
  your Chrome + extension ──WebSocket──►└──────────────┘
```

It is worth doing when the agents that drive the browser already live in the
cluster: they reach `/mcp` over the network instead of over an ssh hop, several
browsers on different machines can be paired to the same server, and the token
store survives a restart on a volume.

What it does **not** change: the browser is still a real Chrome with the
extension installed, running wherever you are. The pod drives a browser; it does
not contain one.

## Install

```bash
# 1. Build and push the image (no image is published for this project)
docker build -t <registry>/agent-jake-browser-mcp-server:<tag> .
docker push <registry>/agent-jake-browser-mcp-server:<tag>

# 2. Point the manifests at it and at your own hostname
#    - kustomization.yaml : images[].name / newTag
#    - configmap.yaml     : publicWsUrl, publicOrigin
#    - ingress.yaml       : host, class, TLS (or delete it)
#    - networkpolicy.yaml : your ingress controller's namespace and pod labels
#    Label a trusted agent namespace (not the browser or ingress namespace):
kubectl label namespace <agent-namespace> agent-jake-browser/mcp-client-namespace=true
#    Persist the client label on its Deployment pod template. This rolls its
#    pods; a one-off `kubectl label pod` disappears at replacement.
kubectl -n <agent-namespace> patch deployment <agent-deployment> --type merge \
  -p '{"spec":{"template":{"metadata":{"labels":{"agent-jake-browser/client":"true"}}}}}'

# 3. Apply
kubectl apply -k deploy/k8s

# 4. Build the extension separately. Zip the CONTENTS of its dist directory,
#    with manifest.json at the archive root. The server image does not contain
#    this sibling project. Copy the ZIP to the persistent volume and repeat
#    after updating the extension.
(cd ../agent-jake-browser-mcp-extension && npm ci && npm run build && \
  cd dist && zip -qr ../agent-jake-browser-extension.zip .)
kubectl -n agent-jake-browser cp \
  ../agent-jake-browser-mcp-extension/agent-jake-browser-extension.zip \
  <agent-jake-browser-pod>:/data/agent-jake-browser-extension.zip
#    Check that /download returns 200 and a ZIP with config.json before pairing.

# 5. Pair a browser
#    Install the extension, start pairing in its popup, then approve the code at
#    https://<your-host>/pair
```

Point an MCP client at `http://agent-jake-browser.agent-jake-browser.svc:8000/mcp`
from inside the cluster.

## The one thing to get right

**The MCP endpoint has no authentication.** On a laptop that is fine, because the
server binds it to loopback and says so in the code. A pod's loopback is
reachable by nothing, so this deployment binds `0.0.0.0` — and the protection
that loopback was providing has to come from somewhere else.

Here it comes from `networkpolicy.yaml`: deny everything, then allow port 8000
only from pods labelled `agent-jake-browser/client=true` in namespaces labelled
`agent-jake-browser/mcp-client-namespace=true`. Treat that
file as part of the deployment, not as optional hardening. Applied without it,
any pod in the cluster can drive a browser holding your logged-in sessions —
your mail, your bank, everything the browser is signed into.

Only trusted cluster administrators should be able to set the namespace label.
Anyone who can create labelled pods in an allowed namespace can reach `/mcp`;
the labels are an access control boundary, not client authentication. Verify
your namespace RBAC and admission policies before using this with other tenants.
The Ingress exposes only named browser routes and `/ws`; `/` is deliberately
absent, so the landing page is internal only. Use `/pair` for browser setup.
Never add `/`, `/mcp`, or a catch-all route without separate MCP authentication.
Use a dedicated host: ingress-nginx may reinterpret even `Exact` paths as
regular expressions when any Ingress on the same host uses `use-regex` or
`rewrite-target`. Audit all Ingress objects for this host and prevent other
teams from adding conflicting routes. See the
[ingress-nginx path matching warning](https://kubernetes.github.io/ingress-nginx/user-guide/ingress-path-matching/#warning).

Two ways that goes wrong quietly:

- **Your CNI ignores NetworkPolicy.** Plain flannel and some managed defaults do.
  Then these files apply cleanly, report nothing, and enforce nothing. Check with
  a pod that should be denied before you trust it.
- **You expose the Ingress publicly.** `/pair/approve` mints a real browser token
  for anyone presenting a valid pairing code. Keep the host on a private network
  or behind a proxy that authenticates. Only `/pair/start` and `/pair/status`
  grant CORS to Chrome extension origins; the approval response does not.
- **Your proxy logs full request URLs.** `/ws?token=` and `/pair/status?otp=` carry
  credentials. The example disables ingress-nginx access logs for this Ingress;
  disable or redact URL logging in any upstream proxy too.

## Why one replica

`replicas: 1` and `strategy: Recreate` are load-bearing. The open extension
sockets, the connection registry and the pending pairing codes all live in the
process. With two replicas the extension's WebSocket lands on one pod and the
agent's tool call on the other, and calls fail with "Extension not connected" —
intermittently, which is the hardest version to diagnose. To drive more
browsers, pair more browsers to the one server: each gets its own connection id,
and tools take a `connection` argument.

## Environment

Every variable is documented once, in the [root README](../../README.md#environment).
What this deployment pins, and why, is in the comments of `deployment.yaml`. The
three you must change for your own cluster are `publicWsUrl` and `publicOrigin`
in `configmap.yaml`, and the image in `kustomization.yaml`.

With neither `BROWSER_WS_TOKEN` nor `BROWSER_ALLOW_PAIRING` set, the WebSocket
accepts any client. The Deployment sets `BROWSER_ALLOW_PAIRING=true` so that
cannot happen by omission.
