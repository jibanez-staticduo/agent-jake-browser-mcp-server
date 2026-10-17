# Evidence SC-2115 (SC-2102 H2) — rama SC-2102-H2-servidor

## Rojo: tests nuevos contra origin/main (e9d7cd7) sin el cambio

Comando, desde una worktree limpia de `origin/main` con solo los 3 ficheros de test y los 2 helpers copiados:

`npx vitest run tests/onepassword-connect.test.ts tests/save-secret.test.ts tests/save-secret-wire.test.ts`

Resultado: **FAIL** — `Test Files 3 failed (3)`, `Tests 51 failed (51)`; `onepassword-connect.test.ts` ni carga (`Cannot find module ../src/onepassword-connect.js`), los otros fallan con `Cannot read properties of undefined (reading handle)` (la herramienta no existe).

## Verde: los mismos tests y `npm test` completo en la rama

`npm run typecheck` sin errores. `npm test` (resumen, salida sin colores):

```
 ✓ tests/deploy-k8s.test.ts (9 tests) 51ms
 ✓ tests/pairing-store.test.ts (5 tests) 10ms
 ✓ tests/connection-target.test.ts (6 tests) 7ms
 ✓ tests/tab-reaper.test.ts (19 tests) 423ms
 ✓ tests/token-store.test.ts (7 tests) 377ms
 ✓ tests/session-tabs.test.ts (8 tests) 354ms
 ✓ tests/pinned-directory.test.ts (2 tests) 47ms
 ✓ tests/published-extension.test.ts (3 tests) 17ms
 ✓ tests/passkey.test.ts (7 tests) 23ms
 ✓ tests/ws-server.test.ts (10 tests) 813ms
 ✓ tests/fill-secret.test.ts (4 tests) 500ms
 ✓ tests/server.test.ts (14 tests) 603ms
 ✓ tests/tool-connections.test.ts (3 tests) 11ms
 ✓ tests/devtools-tools.test.ts (15 tests) 1114ms
 ✓ tests/save-secret.test.ts (40 tests) 1241ms
 ✓ tests/save-secret-wire.test.ts (11 tests) 1871ms
 ✓ tests/onepassword-connect.test.ts (47 tests) 3626ms
 ✓ tests/http-routes.test.ts (21 tests) 7139ms
 Test Files  18 passed (18)
      Tests  231 passed (231)
```

Resultado: **PASS** — 18 ficheros, 231 tests. Los 3 ficheros nuevos: 47 + 40 + 11 = 98 tests.

## Criterios de 00-spec.md

1. Parámetros y respuesta exacta: `tests/save-secret.test.ts` («answers exactly…»).
2. Errores con texto fijo y UNKNOWN_TOOL con un solo mensaje: `save-secret.test.ts` («what the extension can answer», «nothing is read from the page…») y `save-secret-wire.test.ts`.
3. Escritura (token con trim, cabeceras, timeout 30000, POST/GET+PUT, FIELD_EXISTS, split/join, base32): `onepassword-connect.test.ts` y `save-secret.test.ts` («normalisation and template»).
4. Cero fugas: `save-secret.test.ts` («nothing leaks out of the process») y `save-secret-wire.test.ts`, con los canarios CANARY-SEED-7F3A9C21 y EXISTING-SECRET-1B2C.
5. Tests que fallan antes: sección Rojo; RFC 6238 = 287082 en `save-secret.test.ts`; `vi.mock(node:child_process)` que lanza; fake-connect suelto en `onepassword-connect.test.ts` («run alone»).
6. `scripts/check-deltas.sh`: dos aserciones nuevas, ambas `ok`; probado que falla si el módulo contiene `DELETE`.
7. README.md y ARCHITECTURE.md actualizados.
8. Rama y SHA: en `50-entrega.md` del ticket.

## Integracion local revisada 2026-10-16 (cierre PR22 + PR24)

- Base: `03b673d476e5edc3dc9d3d34a91fdf806e916939` (ventanas, ownership y cola).
- Segundo padre del merge: `19e6a11b26ec67e5371466129188c59f71d88ada` (PR24).
- Validacion Node `v22.22.2`: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `bash scripts/check-deltas.sh`: PASS. Suite final: **20 archivos / 289 tests**; las cifras anteriores documentan la rama original, no este candidato.
- Resultado publico corregido: `{saved:true,destination}` sin valor ni longitud. Errores cerrados sin conteos, mensajes o codigos arbitrarios de la extension; fallos de transporte sanitizados. El catalogo omite save_secret sin origen HTTP(S), token de escritura y allowlist de IDs validos; un handler retenido tambien lo rechaza antes del navegador.
- RE2JS `2.8.6` exacto, expresion <=256 y grupo de captura obligatorio, sin lookaround/backreferences. Valor final <=4096 despues de plantilla, OTP final validado.
- Connect: origen sin credenciales/path/query/fragment, IDs y vinculo vault/item/version validados en respuestas, redirecciones rechazadas, timeout 30s, JSON limitado a 2MiB. Solo GET/POST/PUT; token separado y allowlist por ID.
- Concurrencia local: cola por vault, metadatos de versiones/titulos intentados sin valores, rechazo de lecturas atrasadas y creaciones repetidas, fallo cerrado al alcanzar 1000 registros. Los intentos inciertos tambien se recuerdan; no hay reintento automatico. GET fresco conserva campos y version para PUT. Esta proteccion es por proceso; reinicio y escritores externos exigen QA del proveedor.
- WebSocket: respuesta solo desde el socket y connectionId esperados, cierre/reemplazo invalida pendientes, sin longitud de mensaje o datos arbitrarios en log. Tres tests reales nuevos reproducen el defecto previo; dos tests de guardado prueban targetTabId propio y rechazo de pestaña ajena.
- Fuentes consultadas mediante LazyMCP Kindly y Context7: https://www.1password.dev/connect/api-reference y especificacion oficial `https://i.1password.com/media/1password-connect/1password-connect-api_1.8.1.yaml`; Context7 `/1password/connect-sdk-js`; RE2JS README oficial y `/google/re2`. El esquema incluye SECURE_NOTE, OTP y version, pero NO documenta garantia atomica ni respuesta 409 para PUT. El fake que rechaza versiones antiguas verifica el cliente, no esa propiedad del Connect real.
- Review independiente de flujo secreto: sin defecto bloqueante local tras las correcciones. No se usaron cuentas reales, no se habilito fill_secret o escritura live, no hubo push ni despliegue. QA HTTP real con proveedor falso se registra aparte por su propietario.
- `npm ci` informa 10 avisos de dependencias (1 moderado, 7 altos, 2 criticos); no se cambio el conjunto preexistente de paquetes fuera de RE2JS.
