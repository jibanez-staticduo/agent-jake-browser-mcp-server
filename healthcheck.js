import net from 'node:net';
import http from 'node:http';

function checkTcp(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 3000 }, () => {
      socket.end();
      resolve();
    });

    socket.on('timeout', () => {
      socket.destroy(new Error(`TCP port ${port} timed out`));
    });
    socket.on('error', reject);
  });
}

function checkHttp(pathname, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, timeout: 3000 }, (res) => {
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
  checkTcp(8765),
  checkHttp('/healthz', 8000),
]);
