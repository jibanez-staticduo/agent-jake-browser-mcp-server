export const INDEX_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Jake Browser MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 2rem 1.25rem; max-width: 48rem; }
  h1 { font-size: 1.3rem; margin-bottom: .25rem; }
  .muted { opacity: .7; }
  ul { padding-left: 1.1rem; }
  code { font-family: ui-monospace, monospace; font-size: .9em; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid rgba(127,127,127,.3); font-size: .9rem; }
  .badge { border: 1px solid rgba(127,127,127,.5); border-radius: 999px; padding: .05rem .5rem; font-size: .8rem; }
  .active { border-color: #2e7d32; }
</style>
</head>
<body>
<h1>Agent Jake Browser MCP</h1>
<p class="muted">Servidor MCP que pilota los navegadores conectados por extensión.</p>
<ul>
  <li><a href="/download">Descargar la extensión</a> (zip con esta URL y token embebidos si usas el flujo de pairing)</li>
  <li><a href="/pair">Aprobar un código de pairing</a></li>
  <li><code>/mcp</code> — endpoint MCP (streamable HTTP)</li>
</ul>
<h2>Conexiones ahora mismo</h2>
<div id="connections" class="muted">Cargando…</div>
<script>
async function load() {
  const box = document.getElementById('connections');
  try {
    const res = await fetch('/connections', { headers: { accept: 'application/json' } });
    const data = await res.json();
    if (!data.connections || data.connections.length === 0) {
      box.textContent = 'Ninguna conexión abierta. Instala la extensión y páreala con un código.';
      return;
    }
    const element = (tag, text) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const table = element('table');
    const head = element('thead');
    const headings = element('tr');
    for (const title of ['connectionId', 'Equipo / navegador', 'estado', 'última actividad', '']) {
      headings.appendChild(element('th', title));
    }
    head.appendChild(headings);
    table.appendChild(head);
    const body = element('tbody');
    for (const c of data.connections) {
      const row = element('tr');
      const id = element('td');
      id.appendChild(element('code', c.connectionId));
      row.appendChild(id);
      row.appendChild(element('td', c.label || (c.clientIp ? 'IP ' + c.clientIp : 'Desconocido')));
      row.appendChild(element('td', c.open ? 'abierta' : 'cerrada'));
      row.appendChild(element('td', Math.round(c.secondsSinceLastActivity) + 's'));
      const active = element('td');
      if (c.active) {
        const badge = element('span', 'activa');
        badge.className = 'badge active';
        active.appendChild(badge);
      }
      row.appendChild(active);
      body.appendChild(row);
    }
    table.appendChild(body);
    const status = element('p', 'Auth: ' + (data.authEnabled ? 'token requerido' : 'sin token') + ' · WS: ');
    status.className = 'muted';
    status.appendChild(element('code', data.wsUrl));
    box.replaceChildren(table, status);
  } catch (err) {
    box.textContent = 'No se pudo leer /connections: ' + err;
  }
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;

export const PAIR_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parear navegador · Agent Jake Browser</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 2rem 1.25rem; max-width: 34rem; }
  label { display: block; margin-top: 1rem; }
  input { width: 100%; padding: .5rem; font: inherit; }
  button { margin-top: 1rem; padding: .6rem 1rem; font: inherit; cursor: pointer; }
  pre { background: rgba(127,127,127,.15); padding: .75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .muted { opacity: .7; }
  .error { color: #b3261e; }
</style>
</head>
<body>
<h1>Parear un navegador</h1>
<p class="muted">Introduce el código que muestra el popup de la extensión. Al aprobarse se emite un token de un solo uso para esa instalación.</p>
<form id="form">
  <label for="otp">Código de pairing
    <input id="otp" autocomplete="one-time-code" placeholder="ABC123" maxlength="128">
  </label>
  <button type="submit">Aprobar y emitir token</button>
</form>
<p id="message" class="muted"></p>
<pre id="result" hidden></pre>
<script>
  const params = new URLSearchParams(location.search);
  const otpInput = document.getElementById('otp');
  const message = document.getElementById('message');
  const result = document.getElementById('result');
  if (params.get('otp')) otpInput.value = params.get('otp');

  document.getElementById('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const otp = otpInput.value.trim();
    message.className = 'muted';
    message.textContent = 'Aprobando…';
    try {
      const res = await fetch('/pair/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ otp }),
      });
      const data = await res.json();
      if (!res.ok) {
        message.className = 'error';
        message.textContent = data.error || ('Error ' + res.status);
        result.hidden = true;
        return;
      }
      message.className = 'muted';
      message.textContent = 'Aprobado. Configura la extensión con estos datos:';
      result.hidden = false;
      result.textContent = 'URL del servidor: ' + data.wsUrl + '\\nToken: ' + data.token;
    } catch (err) {
      message.className = 'error';
      message.textContent = 'Fallo la petición: ' + err;
    }
  });
</script>
</body>
</html>`;

