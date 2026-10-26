# Revalidación local de CAI Market V1.1 antes de producción

Fecha: 26 de octubre de 2026, America/Bogota.

Rama: `feature/cai-market-v1.1`.

Esta verificación ejecuta código local con registros ficticios. No ejecuta la
migración 009 sobre Supabase, no despliega Cloudflare, no modifica datos reales y
no crea commits o fusiones. Los logs completos permanecen fuera de Git en
`.cache/v11-preprod-tests/`.

## Alcance de las pruebas

- API: autenticación y manejo de errores, validación de cuerpos y respuestas,
  CORS, denegación de acciones administrativas por HTTP directo para Cajero,
  Supervisor pendiente de reclasificación, autenticación reciente del reinicio,
  imágenes privadas, actualización mediante CAS y prevención de datos sensibles
  en los registros.
- PostgreSQL: 83 contratos publicados de V1, fijados a 001–008, y 42 casos V1.1
  sobre la actualización 009. Estos últimos prueban crédito por el vendedor sin
  cupo previo, homónimos separados por UUID, abono inicial sin duplicación,
  abonos dirigidos, filtros de deuda, stock y total esperado, caja propia,
  rechazos por roles, referencias entre períodos, reinicio idempotente y
  conservación de todas las columnas y filas originales al actualizar.
- Interfaz: navegador → Worker local → RPC reales en PGlite. Los límites de
  Supabase Auth y del almacenamiento se simulan explícitamente. Las fotografías
  se transmiten como binarios y el navegador comprueba que pueden decodificarse.
- Artefacto: compilación, ausencia de marcadores de demostración o claves secretas
  de los patrones comprobados, cabeceras de Pages y CSP sobre el bundle servido
  localmente. Todas las solicitudes no locales se interceptan.
- Runtime: workerd real, `redirect: manual`, timeouts, Auth y RPC, rechazo de
  redirecciones, perfil ajeno, CORS y privacidad de diagnósticos. El servicio de
  salida se sustituye por un handler que rechaza hosts/rutas inesperados.

## Resultados

| Comando | Resultado |
| --- | --- |
| `npm run test:api` | 178 aprobadas; exit 0 |
| `npm run test:credit` | 125 aprobadas; exit 0 |
| `npx playwright test --workers=1` | 47 aprobadas; exit 0 |
| `npm run check:api` | Aprobado; exit 0 |
| `npm run check:credit` | Aprobado; exit 0 |
| `npm run lint` | Aprobado, sin advertencias de lint |
| `npx tsc -b` | Aprobado; exit 0 |
| `npm run build` | Aprobado; advertencia de tamaño del chunk principal, 512,48 kB |
| `node scripts/check-v1-build.mjs` | Aprobado; sin coincidencias de los marcadores prohibidos comprobados |
| `node scripts/verify-frontend-artifact.mjs` | 7 comprobaciones aprobadas, cero solicitudes remotas |
| `node scripts/verify-worker-runtime.mjs` | 14 comprobaciones aprobadas, cero solicitudes remotas |

Ventana de ejecución: aproximadamente 06:55–07:03, hora Colombia. Las pruebas de
interfaz terminaron en unos 3,9 minutos. No hubo casos fallidos u omitidos en esta
revalidación. Las suites iniciales de API/SQL obtuvieron 163/125 aprobadas; tras
el ajuste preventivo descrito a continuación se repitieron API, su TypeScript,
lint y workerd, incorporando 15 pruebas nuevas de aislamiento, con 178 API
aprobadas. Los formularios y el SQL no se modificaron en ese ajuste.

La migración 009 conserva el SHA-256:
`0953e43c041ef2d10877100755008ae62d2e648a65b6fe1024d0df77f0f127db`.

## Problema local encontrado y corregido

`npm run dev:api` todavía seleccionaba `worker/api/wrangler.jsonc`. Aunque
`wrangler dev --local` ejecuta el Worker y R2 localmente, no impide por sí solo
que un `fetch` llegue al Supabase remoto configurado. No se ejecutó ese comando
contra producción.

Se corrigió exclusivamente el procedimiento local:

1. `package.json` selecciona ahora `worker/api/wrangler.local.jsonc --local`.
2. Esa configuración usa `LOCAL_ONLY="true"`, un destino `.invalid` por defecto
   y R2 con `remote: false`.
3. El Worker, al recibir `LOCAL_ONLY`, exige el valor exacto `"true"`. Un valor
   vacío, `"false"` u otro valor no desactiva el control: rechaza la configuración.
4. En ese modo sólo admite destinos loopback o nombres reservados `.invalid`.
   HTTP se permite únicamente en loopback y con el modo local activo. No acepta
   URLs de Supabase remoto, incluso si `.dev.vars` sobreescribe `SUPABASE_URL`.
5. El rechazo ocurre antes de la primera llamada a Auth y devuelve un 503
   normalizado sin URL, claves, JWT, mensajes originales o trazas.

La configuración publicada permanece sin cambios y no incorpora `LOCAL_ONLY`.
La ausencia del indicador conserva el requisito HTTPS y el comportamiento de
producción; no debe añadirse `LOCAL_ONLY="false"` a producción. El flag no es
una variable `VITE_`, no llega al navegador y no desactiva JWT, permisos o CORS.
Se añadieron pruebas del comando/configuración, destinos remotos rechazados,
valores inválidos del indicador, salidas loopback controladas y compatibilidad
de HTTPS sin el indicador.

Archivos de este ajuste: `package.json`, `worker/api/src/index.ts`,
`worker/api/wrangler.local.jsonc` y `tests/api/v11-development.spec.ts`. No se
modificaron el Wrangler de producción, sus variables/secretos, las migraciones
ni los datos comerciales.

## Límites de interpretación

Estas pruebas verifican la lógica V1.1 y sus controles, pero no equivalen a un
inicio de sesión real en Supabase ni comprueban por sí solas las ACL efectivas del
bucket remoto R2. Las solicitudes HTTP directas probadas llegan al Worker local;
el Worker publicado continúa en V1 hasta una actualización expresamente
autorizada. Tampoco se usa esta suite como sustituto de restaurar un respaldo
reciente y ensayar 009 sobre una copia del estado actual del proyecto original.

PGlite comprueba SQL y transacciones, pero no demuestra concurrencia entre
conexiones independientes. Ese resultado se obtiene del arnés PostgreSQL real y
del ensayo aislado del respaldo, que se documentan por separado.

La compilación no publica nada. La advertencia del chunk principal de
aproximadamente 512 kB no es un error de autenticación, integridad o seguridad;
permanece como una oportunidad de optimización, sin ocultar la advertencia ni
alterar límites para que el build pase.
