export function setupPage(nonce: string) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Emparejar Agent Jake</title>
  <style nonce="${nonce}">
    body { font: 1rem system-ui, sans-serif; margin: 4rem auto; padding: 0 1.25rem; max-width: 30rem; color-scheme: light dark; }
    h1 { font-size: 1.75rem; }
    label { display: block; margin: .9rem 0; }
    label[hidden] { display: none; }
    input { display: block; margin-top: .35rem; padding: .45rem; max-width: 95%; }
    button { padding: .45rem .8rem; }
  </style>
</head>
<body>
  <h1>Emparejar Agent Jake</h1>
  <p id="message" role="status">Comprobando el emparejamiento&hellip;</p>
  <form id="details" hidden>
    <label id="host-field" hidden>Nombre del equipo
      <input id="host" type="text" maxlength="62" autocomplete="off" disabled>
    </label>
    <label id="profile-field" hidden>Nombre del perfil del navegador
      <input id="profile" type="text" maxlength="62" autocomplete="off" disabled>
    </label>
    <button>Emparejar</button>
  </form>
  <script nonce="${nonce}">
    const code = new URLSearchParams(location.search).get('code');
    history.replaceState(null, '', '/setup');
    const message = document.querySelector('#message');
    const form = document.querySelector('#details');
    const inputs = ['host', 'profile'].map((name) => document.getElementById(name));
    const button = form.querySelector('button');

    async function approve(values = {}) {
      button.disabled = true;
      try {
        const response = await fetch('/setup/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, ...values }),
          credentials: 'omit',
          cache: 'no-store',
        });
        if (response.status === 422) {
          const { missing, conflict } = await response.json();
          for (const input of inputs) {
            const needed = missing.includes(input.id);
            document.getElementById(input.id + '-field').hidden = !needed;
            input.disabled = !needed;
            input.required = needed;
          }
          form.hidden = false;
          inputs.find((input) => !input.disabled)?.focus();
          message.textContent = conflict
            ? 'Ese nombre ya est\u00e1 en uso. Elige otro nombre de perfil.'
            : 'Completa los datos para identificar este navegador.';
          return;
        }
        form.hidden = true;
        message.textContent = response.ok
          ? 'Emparejamiento aprobado. Vuelve a Agent Jake para terminar.'
          : 'Abre un nuevo emparejamiento desde la extensi\u00f3n.';
      } catch {
        message.textContent = 'No se pudo contactar con el servidor. Int\u00e9ntalo de nuevo desde Agent Jake.';
      } finally {
        button.disabled = false;
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      for (const input of inputs) {
        if (!input.disabled) values[input.id] = input.value;
      }
      void approve(values);
    });
    if (/^[A-Za-z0-9_-]{43}$/.test(code || '')) void approve();
    else message.textContent = 'Abre el enlace de emparejamiento desde la extensi\u00f3n.';
  </script>
</body>
</html>`;
}
