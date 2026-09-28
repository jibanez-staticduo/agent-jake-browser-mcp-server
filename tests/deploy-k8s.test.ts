/**
 * Guards for the Kubernetes deployment.
 *
 * These manifests carry a security contract that is easy to break by accident,
 * because breaking it makes nothing fail: the pod still starts, the tools still
 * work, and the only difference is that the whole cluster can now drive a
 * browser holding the user's logged-in sessions. So the contract is asserted
 * here instead of being left to review.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const K8S_DIR = join(import.meta.dirname, '..', 'deploy', 'k8s');
const read = (name: string) => readFileSync(join(K8S_DIR, name), 'utf-8');

describe('deploy/k8s manifests', () => {
  it('binds both listeners to 0.0.0.0, because a pod cannot use loopback', () => {
    const deployment = read('deployment.yaml');
    expect(deployment).toMatch(/name:\s*MCP_HTTP_HOST\s*\n\s*value:\s*"0\.0\.0\.0"/);
    expect(deployment).toMatch(/name:\s*BROWSER_WS_HOST\s*\n\s*value:\s*"0\.0\.0\.0"/);
  });

  it('ships the NetworkPolicy that replaces the loopback boundary', () => {
    const kustomization = read('kustomization.yaml');
    expect(kustomization).toContain('networkpolicy.yaml');

    const policy = read('networkpolicy.yaml');
    // A default-deny must exist: the allow rules below only mean something
    // while something is denying the rest.
    expect(policy).toContain('agent-jake-browser-default-deny');
    // And the MCP port must never be opened to an unqualified source.
    expect(policy).toMatch(/agent-jake-browser\/client:\s*"true"/);
    expect(policy).toMatch(/agent-jake-browser\/mcp-client-namespace:\s*"true"/);
    expect(policy).not.toContain('namespaceSelector: {}');
    expect(policy).toMatch(/agent-jake-browser-allow-public-routes-from-ingress[\s\S]*port:\s*8000/);
    expect(policy).toMatch(/kubernetes.io\/metadata.name:\s*ingress-nginx[\s\S]*app.kubernetes.io\/name:\s*ingress-nginx/);
  });

  it('publishes only the browser routes and never the MCP endpoint', () => {
    const ingress = read('ingress.yaml');
    const paths = [...ingress.matchAll(/^\s+- path: (\S+)\s*\n\s+pathType: (\S+)/gm)]
      .map((match) => [match[1], match[2]]);
    expect(paths).toEqual([
      ['/ws', 'Prefix'], ['/download', 'Exact'],
      ['/connections', 'Exact'], ['/pair', 'Exact'], ['/pair/start', 'Exact'],
      ['/pair/approve', 'Exact'], ['/pair/status', 'Exact'],
    ]);
    // ingress-nginx may reinterpret Exact / as regex ^/ if any Ingress on the
    // same host uses use-regex or rewrite-target. That would also match /mcp.
    expect(paths.some(([path]) => path === '/' || path === '/mcp')).toBe(false);
    expect(ingress).toContain('nginx.ingress.kubernetes.io/enable-access-log: "false"');
  });

  it('labels the MCP client Deployment template instead of a disposable pod', () => {
    const instructions = read('README.md');
    expect(instructions).toContain('patch deployment <agent-deployment>');
    expect(instructions).toContain('agent-jake-browser/client');
    expect(instructions).not.toMatch(/^kubectl label pod /m);
  });

  it('keeps the WebSocket authenticated by default', () => {
    // Auth is off unless a static token or pairing is configured, so the
    // Deployment has to opt in explicitly — omission is the unsafe state.
    expect(read('deployment.yaml')).toMatch(/name:\s*BROWSER_ALLOW_PAIRING\s*\n\s*value:\s*"true"/);
  });

  it('stays at one replica: the sockets and pairing codes live in the process', () => {
    const deployment = read('deployment.yaml');
    expect(deployment).toMatch(/^\s{2}replicas:\s*1\s*$/m);
    expect(deployment).toMatch(/type:\s*Recreate/);
  });

  it('runs unprivileged', () => {
    const deployment = read('deployment.yaml');
    expect(deployment).toMatch(/runAsNonRoot:\s*true/);
    expect(deployment).toMatch(/allowPrivilegeEscalation:\s*false/);
    expect(deployment).toMatch(/readOnlyRootFilesystem:\s*true/);
  });

  it('gives the token store and the tool output a writable volume', () => {
    // With a read-only root filesystem the defaults under /app are not
    // writable, so both have to be pointed somewhere that is.
    const deployment = read('deployment.yaml');
    expect(deployment).toMatch(/name:\s*BROWSER_TOKEN_STORE\s*\n\s*value:\s*\/data\//);
    expect(deployment).toMatch(/name:\s*AGENT_BROWSER_OUT_DIR\s*\n\s*value:\s*\/data\//);
    expect(deployment).toMatch(/mountPath:\s*\/data/);
    expect(deployment).toMatch(/name:\s*BROWSER_EXTENSION_ZIP\s*\n\s*value:\s*\/data\/agent-jake-browser-extension\.zip/);
  });
});

describe('environment documentation', () => {
  it('documents every variable the server reads', () => {
    // Drift here is silent and expensive: an operator deploying from the README
    // cannot configure a variable nobody wrote down.
    const sources = ['http-server.js', 'healthcheck.js'];
    const srcDir = join(import.meta.dirname, '..', 'src');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : entry.name.endsWith('.ts')
            ? [join(dir, entry.name)]
            : [],
      );

    const files = [
      ...sources.map((name) => join(import.meta.dirname, '..', name)),
      ...walk(srcDir),
    ];

    const used = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        const name = match[1]!;
        // Only this project's own knobs; NODE_ENV and friends are not ours.
        if (/^(BROWSER_|MCP_|AGENT_BROWSER_)/.test(name)) used.add(name);
      }
    }

    const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf-8');
    const undocumented = [...used].filter((name) => !readme.includes(`\`${name}\``)).sort();

    expect(used.size).toBeGreaterThan(0);
    expect(undocumented).toEqual([]);
  });
});
