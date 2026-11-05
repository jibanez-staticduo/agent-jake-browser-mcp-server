/**
 * GET /install (INFRA-932): the installer of the extension, as a bash script for
 * `curl -fsSL <origin>/install | bash`. It downloads /download into
 * ~/Downloads/agent-jake-browser, the folder the extension rewrites by itself on every
 * published build, and leaves Chrome's two manual steps in sight: branded Chrome loads a
 * private extension only with developer mode on and the folder loaded by hand
 * (--load-extension is gone since Chrome 137; a forcelist policy needs an MDM-managed Mac).
 *
 * The origin ends up inside the shell script and comes from request headers, so anything
 * that is not a plain http(s) origin is refused.
 */
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

// No `${` nor backticks inside: this is a JS template literal.
const SCRIPT = `#!/usr/bin/env bash
# Instalador de la extensión de agent-jake (INFRA-932). La deja en Descargas/agent-jake-browser,
# la carpeta que la extensión reescribe sola con cada versión publicada.
set -euo pipefail

ORIGIN='__ORIGIN__'
DEST="$HOME/Downloads/agent-jake-browser"

if [ -e "$DEST" ] && [ ! -f "$DEST/manifest.json" ]; then
  echo "$DEST existe y no es una extensión: no la toco. Muévela y vuelve a lanzar el instalador." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Descargando la extensión de $ORIGIN/download"
curl -fsSL "$ORIGIN/download" -o "$tmp/extension.zip"
mkdir "$tmp/extension"
unzip -q "$tmp/extension.zip" -d "$tmp/extension"
if [ ! -f "$tmp/extension/manifest.json" ]; then
  echo "El zip de $ORIGIN/download no trae manifest.json en la raíz: no instalo nada." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mv "$tmp/extension" "$DEST"
version="$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$DEST/manifest.json" | head -n 1)"

if [ "$(uname -s)" = Darwin ]; then
  open -a "Google Chrome" "chrome://extensions" || echo "No he podido abrir Chrome: abre chrome://extensions a mano."
  open -R "$DEST"
fi

cat <<EOF

Extensión $version instalada en $DEST.

Falta, una sola vez, en Chrome:
  1. En chrome://extensions, activa «Modo desarrollador» (arriba a la derecha).
  2. Arrastra la carpeta agent-jake-browser a esa página (o «Cargar descomprimida» y elígela).
     Si ya estaba cargada desde esa carpeta, pulsa el botón de recargar de su tarjeta.
  3. En la extensión, Opciones → «Emparejar con el servidor», y aprueba el código en $ORIGIN/pair.
  4. Para que se actualice sola: Ajustes → Descargas → desactiva «Preguntar dónde guardar cada archivo».
EOF
`;

/** The installer with `origin` baked in, or null when `origin` is not a plain http(s) origin. */
export function installerScript(origin: string): string | null {
  if (!ORIGIN_RE.test(origin)) return null;
  return SCRIPT.replace('__ORIGIN__', origin);
}
