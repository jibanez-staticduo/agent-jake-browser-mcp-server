import net from 'node:net';
import http from 'node:http';

// Mirror the ports the server actually binds: a compose file or a Kubernetes
// Deployment that moves them must not turn the healthcheck into a false red.
const WS_PORT = Number(process.env.BROWSER_WS_PORT || 8765);
const HTTP_PORT = Number(process.env.MCP_HTTP_PORT || 8000);
const WS_HOST = process.env.BROWSER_WS_HOST || '127.0.0.1';
const HTTP_HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const connectHost = (host) => host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;

function checkTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: connectHost(host), port, timeout: 3000 }, () => {
      socket.end();
      resolve();
    });

    socket.on('timeout', () => {
      socket.destroy(new Error(`TCP port ${port} timed out`));
    });
    socket.on('error', reject);
  });
}

function checkHttp(pathname, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: connectHost(host), port, path: pathname, timeout: 3000 }, (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`HTTP ${pathname} returned ${res.statusCode}`));
      }
      res.destroy();
    });

    req.on('timeout', () => {
      req.destroy(new Error(`HTTP ${pathname} timed out`));
    });
    req.on('error', reject);
  });
}

await Promise.all([
  checkTcp(WS_HOST, WS_PORT),
  checkHttp('/healthz', HTTP_HOST, HTTP_PORT),
]);
