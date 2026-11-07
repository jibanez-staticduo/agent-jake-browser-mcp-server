/** Signed, fail-closed installer for the neutral extension release artifact. */
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const WS_RE = /^wss?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[-A-Za-z0-9._~%!$&()*+,;=:@\/]*)?$/;
const PUBLIC_KEY_DER_B64 = 'MCowBQYDK2VwAyEA8c8tp8Jvr8S8GnkZHdL79/6y9f/99sisBAooeem1wRQ=';
const INSTALL_INSTANCE_RE = /^(nas|fedora|ari)$/;

const SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
ORIGIN='__ORIGIN__'; WS_URL='__WS_URL__'; INSTALL_INSTANCE='__INSTALL_INSTANCE__'; DEST="$HOME/Downloads/agent-jake-browser"
command -v curl >/dev/null || { echo 'Falta curl; no se instala nada.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Falta python3; no se instala nada.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'Falta openssl con soporte Ed25519; no se instala nada.' >&2; exit 1; }
parent="$(dirname "$DEST")"; mkdir -p "$parent"
tmp="$(mktemp -d "$parent/.agent-jake-install.XXXXXX")"; stage="$tmp/stage"
cleanup() { rm -rf "$tmp" "$stage"; }; trap cleanup EXIT HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$ORIGIN/download/latest.json" -o "$tmp/latest.json"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$ORIGIN/download/artifact.zip" -o "$tmp/artifact.zip"
printf '%s' '__PUBKEY__' > "$tmp/pubkey.b64"
python3 - "$tmp/latest.json" "$tmp/artifact.zip" "$tmp/pubkey.b64" "$WS_URL" "$INSTALL_INSTANCE" "$stage" "$DEST" <<'PY'
import base64, hashlib, json, os, pathlib, re, subprocess, sys, zipfile
latest_path, archive, pubkey_b64_path, ws_url, install_instance, stage, dest = sys.argv[1:]
try:
    latest = json.load(open(latest_path, encoding='utf-8'))
    pubkey = os.path.join(os.path.dirname(archive), 'release.pub')
    open(pubkey, 'wb').write(base64.b64decode(open(pubkey_b64_path, encoding='ascii').read(), validate=True))
    with zipfile.ZipFile(archive) as z:
        listing = z.read('update-files.json')
        sig = base64.b64decode(z.read('update-files.json.sig'), validate=True)
        files = json.loads(listing)
        if not isinstance(files, dict) or not isinstance(files.get('files'), list) or not {'version','build','sha','files'} <= set(files): raise ValueError('formato de update-files.json')
        if any(latest.get(k) != files.get(k) for k in ('version', 'build', 'sha')): raise ValueError('identidad latest no coincide')
        entries = z.infolist()
        names = [i.filename for i in entries if not i.is_dir()]
        expected_names = set(item['path'] for item in files['files']) | {'manifest.json','update-files.json','update-files.json.sig'}
        if len(names) != len(set(names)) or set(names) != expected_names: raise ValueError('listado del ZIP no coincide')
    expected = {}
    for item in files['files']:
        if not isinstance(item, dict) or set(item) != {'path','sha256','size'}: raise ValueError('entrada de release invalida')
        p, h, size = item['path'], item['sha256'], item['size']
        if not isinstance(p, str) or not p or p.startswith('/') or chr(92) in p or '..' in pathlib.PurePosixPath(p).parts: raise ValueError('ruta insegura')
        if not re.fullmatch(r'[0-9a-f]{64}', h) or not isinstance(size, int) or size < 0 or p in expected: raise ValueError('hash/tamano/ruta invalido')
        expected[p] = (h, size)
    if 'manifest.json' not in expected: raise ValueError('manifest ausente del listado firmado')
    listing_path = os.path.join(os.path.dirname(archive), 'update-files.json'); open(listing_path, 'wb').write(listing)
    sig_path = os.path.join(os.path.dirname(archive), 'sig.bin'); open(sig_path, 'wb').write(sig)
    subprocess.run(['openssl','pkeyutl','-verify','-rawin','-pubin','-keyform','DER','-inkey',pubkey,'-in',listing_path,'-sigfile',sig_path], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with zipfile.ZipFile(archive) as z:
        for name, (wanted, size) in expected.items():
            data = z.read(name)
            if len(data) != size or hashlib.sha256(data).hexdigest() != wanted: raise ValueError('hash de artefacto no coincide')
        manifest = json.loads(z.read('manifest.json'))
        if manifest.get('manifest_version') != 3 or not manifest.get('name'): raise ValueError('manifest invalido')
        if manifest.get('version') != files.get('version'): raise ValueError('version del manifest no coincide')
        z.extractall(stage)
    cfg = os.path.join(stage, 'config.json')
    old_cfg = os.path.join(dest, 'config.json')
    if os.path.isfile(old_cfg) and not os.path.islink(old_cfg):
        existing = json.loads(pathlib.Path(old_cfg).read_text(encoding='utf-8'))
        if not isinstance(existing, dict) or existing.get('version') != 1 or not isinstance(existing.get('wsUrl'), str): raise ValueError('config invalida')
        if install_instance and existing.get('installInstance') not in (None, install_instance): raise ValueError('identidad de instalacion no coincide')
        if not install_instance and existing.get('installInstance') not in (None, ''): raise ValueError('identidad de instalacion no coincide')
        if install_instance and existing.get('installInstance') is None:
            existing['installInstance'] = install_instance
            pathlib.Path(cfg).write_text(json.dumps(existing, separators=(',', ':')), encoding='utf-8')
        else:
            pathlib.Path(cfg).write_bytes(pathlib.Path(old_cfg).read_bytes())
    else:
        config = {'version':1, 'wsUrl':ws_url}
        if install_instance: config['installInstance'] = install_instance
        json.dump(config, open(cfg, 'w', encoding='utf-8'), separators=(',', ':'))
except Exception as exc:
    print('No se instala: artefacto o firma no verificable (%s).' % exc, file=sys.stderr); sys.exit(1)
PY
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  [ -d "$DEST" ] && [ -f "$DEST/manifest.json" ] && [ ! -L "$DEST" ] || { echo 'Destino existente no es una extension verificada; no se toca.' >&2; exit 1; }
  if [ -z "$INSTALL_INSTANCE" ] && { [ -e "$DEST/nas" ] || [ -e "$DEST/fedora" ] || [ -e "$DEST/ari" ]; }; then
    echo 'Destino legacy contiene instalaciones por instancia; no se mueve ni respalda.' >&2; exit 1
  fi
  mv -- "$DEST" "$DEST.backup.$(date +%s)"
fi
mv -- "$stage" "$DEST"
echo "Extension verificada instalada en $DEST. Carga la carpeta desde chrome://extensions."
`;

export function installerScript(origin: string, wsUrl: string, options: { publicKeyDerB64?: string; installInstance?: string } = {}): string | null {
  if (!ORIGIN_RE.test(origin) || !WS_RE.test(wsUrl)) return null;
  const publicKey = options.publicKeyDerB64 ?? PUBLIC_KEY_DER_B64;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) return null;
  const installInstance = options.installInstance || '';
  if (installInstance && !INSTALL_INSTANCE_RE.test(installInstance)) return null;
  const destination = installInstance ? `$HOME/Downloads/agent-jake-browser/${installInstance}` : '$HOME/Downloads/agent-jake-browser';
  return SCRIPT.replace('__ORIGIN__', origin).replace('__WS_URL__', wsUrl).replace('__PUBKEY__', publicKey).replace('__INSTALL_INSTANCE__', installInstance).replace('$HOME/Downloads/agent-jake-browser', destination);
}

export const installerPublicKey = PUBLIC_KEY_DER_B64;
