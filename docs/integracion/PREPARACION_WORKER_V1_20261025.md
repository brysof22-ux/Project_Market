# Worker V1: preparación de publicación en producción

**Actualización 25/10/2026, 22:12 Colombia:** Worker V1 publicado con autorización en la versión `84dea860-d785-4387-994b-9bac21126178`; 13 sondas aprobadas, comunicación con Auth verificada y bindings preservados. Ver [resultado de publicación](RESULTADO_WORKER_V1_20261025.md). El resto de este documento conserva la preparación histórica; no volver a desplegar siguiendo su estado entonces pendiente.

**Dictamen: preparado para solicitar autorización de despliegue controlado. No se desplegó.** Verificación del 25/10/2026, aproximadamente 19:25–19:29 Colombia. Proyecto exclusivo Supabase `sauoekefntzxhqxycdgo`; Worker existente `cai-market-api`; rama de trabajo `release/cai-market-v1`, HEAD `385eb8a`. El árbol de trabajo contiene cambios locales anteriores y los controles/documentos añadidos en esta revisión; no se hizo commit ni integración en `main`.

La aplicación completa todavía no está certificada en producción: el Worker público sigue ejecutando el código anterior y Pages todavía no contiene el cliente V1. Esto es una preparación del backend, no una declaración de publicación terminada.

## Resultados ejecutados

| Comprobación | Resultado |
| --- | --- |
| `npm run test:api` | **103/103 PASS**, incluyendo 21 pruebas nuevas de operaciones/reportes |
| `npm run check:api` | PASS: TypeScript del Worker y pruebas/cliente |
| `npm run test:credit` | **83/83 PASS**, seguridad SQL e integridad financiera en PGlite local |
| `npm run check:credit` | PASS |
| `npm run lint` | PASS tras añadir las pruebas y el arnés |
| `node scripts/verify-worker-runtime.mjs` | **14/14 PASS** en workerd real local, con todas las salidas interceptadas |
| Wrangler **4.152.0** `deploy --dry-run` | PASS, empaquetado local sin upload/deploy |
| Inspección del artefacto | Sin patrones de credenciales privadas, claves publishable incrustadas ni entradas `.env`/respaldos; ningún archivo sensible detectado entre los versionados |
| Lectura fresca de Supabase y Data API | PASS: RPC, firmas, permisos, historial y esquemas expuestos |
| Lectura de Cloudflare | PASS: cuenta, Worker, bindings, versión activa y destino de reversión |

El bundle generado en `worker/api/.dry-run/index.js` mide **13.840 bytes** (13,52 KiB; gzip 4,01 KiB). SHA-256: `c8f102761c34c45940ceafa67cf93f03e729e52c7a53d6b609d8d652b8a40f6d`. El dry-run no acredita por sí solo autenticación ni conectividad desde la red de Cloudflare. La primera ejecución encontró un impedimento de escritura del log global de Wrangler; se repitió correctamente usando `WRANGLER_LOG_PATH` dentro del workspace, sin cambiar controles del Worker.

El arnés workerd empaqueta en memoria las mismas fuentes actuales, con la misma fecha de compatibilidad; no ejecuta operaciones contra Supabase. Demuestra que el runtime acepta las opciones nuevas, que usa `fetch` nativo en los caminos Auth/perfil/RPC y que bloquea redirecciones. Las pruebas PGlite no se presentan como pruebas concurrentes PostgreSQL reales ni como operaciones realizadas en producción; los ensayos concurrentes previos constan en sus informes separados.

## Cloudflare: variables, bindings y credenciales

Lectura GET de la API oficial, sin modificar configuración. Se renovó automáticamente la sesión OAuth local existente de Wrangler para poder leer la cuenta; no se crearon credenciales Supabase ni se renovó su rol PostgreSQL.

| Binding remoto | Tipo observado | Verificación |
| --- | --- | --- |
| `SUPABASE_URL` | `plain_text` | Exactamente `https://sauoekefntzxhqxycdgo.supabase.co` |
| `ALLOWED_ORIGIN` | `plain_text` | Exactamente `https://project-market.pages.dev` |
| `SUPABASE_PUBLISHABLE_KEY` | `plain_text` | Formato publishable válido; valor no incluido en el informe ni incorporado al bundle |
| `MEDIA` | `r2_bucket` | Bucket existente `cai-market-media`; binding conservado, sin operaciones R2 en estos endpoints |

No hay bindings `secret_text` configurados en este Worker. La publishable es pública por diseño y no necesita convertirse en secreto para esta publicación. No se encontraron bindings de `service_role`, contraseña/URL PostgreSQL, clave secreta de Supabase ni PAT del CLI. Tampoco patrones de claves privadas en el código publicado, bundle local o bundle público de Pages inspeccionados. Es una comprobación de configuración y patrones conocidos, no una afirmación sobre todo el historial de Git o servicios externos.

`wrangler.jsonc` fija el proyecto original y el origen autorizado, conserva `keep_vars: true`, `MEDIA`, `workers_dev: true` y fecha `2026-10-23`. No hay cron ni dominios personalizados configurados en el Worker actual. Las URLs de versión estaban habilitadas previamente en Cloudflare; no se creó ni utilizó ningún entorno Preview.

Una solicitud de lectura directa desde esta máquina a Auth, con la publishable configurada y únicamente el JWT ficticio `aaa.bbb.ccc`, devolvió **403 / `bad_jwt`**. Esto confirma respuesta HTTP del Auth original con esa configuración; no verifica un login real ni el transporte desde Cloudflare. No se registraron cuerpos, JWT, encabezados ni claves.

## Compatibilidad con Supabase ya actualizado

Se ejecutó [worker_v1_readiness.sql](../../supabase/checks/worker_v1_readiness.sql) mediante el endpoint oficial de Management API de **solo lectura**. Contexto confirmado: `transaction_read_only=on`. El SQL contiene únicamente una consulta de metadatos; no invoca RPC comerciales, no modifica tablas, datos, permisos ni propietarios.

| RPC existente | Uso del Worker | Permisos y contexto |
| --- | --- | --- |
| `public.cai_current_profile()` | `GET /api/me` y validación previa a las operaciones; cuerpo `{}` | SECURITY DEFINER, propietario `pos_owner`, search_path fijo `pg_catalog, pg_temp` |
| `public.cai_catalog(text,jsonb,text)` | `POST /api/catalog`; `p_action`, `p_data`, `p_key` | SECURITY DEFINER, `pos_owner`, search_path fijo `pg_catalog, pos, pg_temp` |
| `public.cai_operations(text,jsonb,text)` | `POST /api/operations`; `p_action`, `p_data`, `p_key` | Mismo propietario/contexto de catálogo |
| `public.cai_report(jsonb)` | Acción `report` en `/api/operations`; únicamente `p_data` | Mismo propietario/contexto de catálogo |

Las cuatro existen, permiten EXECUTE a `authenticated` y lo niegan a PUBLIC, `anon` y `service_role`. Historial exactamente 001–008; seis tablas nuevas presentes; cero tablas `pos` con propietario/RLS inseguros. `pos_owner` continúa sin CREATE sobre `pos`/`public`. Data API expone **`public,graphql_public`**; `pos` permanece privado. No hace falta otra migración, cambio de ACL ni ajuste de Supabase para desplegar este código.

## AUTH_UNAVAILABLE: causa y corrección preparada

La versión publicada aún utiliza `redirect: 'error'`. workerd lo rechaza con `TypeError` al construir Request, antes de hacer red. La documentación oficial de [Cloudflare Request](https://developers.cloudflare.com/workers/runtime-apis/request/) admite los modos implementados `follow` y `manual`; la reproducción local real vuelve a demostrar la diferencia.

La rama V1 **ya contiene** `redirect: 'manual'` en Auth, perfil y RPC comerciales. No fue necesario editar su implementación en esta revisión. Conserva `AbortSignal.timeout(10_000)`, los encabezados originales y la misma identidad. No se siguen `Location`; cualquier 3xx se rechaza mediante `!response.ok`. Auth no incluye la opción `cache`; las RPC y respuestas públicas conservan `no-store`.

- JWT: comprobación sintáctica y tamaño antes de salir; Supabase Auth valida firma/expiración/usuario. No se confía en un JWT decodificado localmente.
- Auth 400/401/403 se normaliza a HTTP 401. Errores de red/timeout y estados inesperados conservan respuestas públicas saneadas; no se concede acceso por fallos del proveedor.
- Perfil propio activo obligatorio y coincidencia de su ID con el usuario validado; solo se devuelven cuatro campos públicos del perfil. Cada operación SQL vuelve a exigir identidad/permisos, con el JWT original y el esquema `public`.
- Instrumentación temporal `auth_diagnostic` conservada: solo fase, duración, estado HTTP, excepción normalizada y timeout. Las pruebas verifican que no incluya datos personales, claves, JWT, cuerpos, mensajes originales ni trazas. Su retirada posterior debe ser un cambio independiente revisado.

La corrección del TypeError está demostrada localmente. **No se afirma todavía que AUTH_UNAVAILABLE esté corregido en el despliegue público**, porque se respetó la instrucción de no desplegar.

## CORS y frontend actualmente publicado

Se conserva `GET /health`, `GET /api/me`, sus contratos JSON/códigos/headers y OPTIONS de perfil. Las rutas nuevas son POST `/api/catalog` y `/api/operations`, con autorización y preflight específico. Origen exacto Pages; sin wildcard/reflexión, sin cookies, sin ID/rol confiado al navegador. Se rechazan orígenes parecidos, `null`, métodos y headers ajenos. Todas las respuestas públicas incluyen `Cache-Control: no-store`.

Lecturas públicas de la versión anterior: health 200, sin token 401, preflight autorizado 204 y origen ajeno 403, con CORS/no-store correctos. JWT ficticio devuelve **503**, por lo que `node scripts/check-deployment.mjs` terminó con código 1, como corresponde al fallo todavía publicado. No se omitió la comprobación ni se cambió su expectativa 401 para hacerla pasar.

El bundle público `/assets/index-Db7PYJLl.js` no contiene la URL del Worker ni `/api/me`; no es todavía el frontend V1. Contiene una referencia `/api/broadcast`, que tampoco existe en el Worker anterior: el backend V1 no retira esa ruta ni promete implementarla. Se preservan las rutas realmente presentes en el Worker anterior y se verifican los contratos del cliente local V1. **La inspección de marcadores no certifica un flujo completo de navegador ni las funcionalidades de la interfaz publicada.** Pages no se modificó y su actualización será un paso separado.

## Publicación preparada, aún no autorizada

Antes de ejecutar, releer la versión activa y los bindings: deben coincidir con esta evidencia. Repetir el dry-run y comprobar huellas si cambia cualquier fuente/configuración. Si aparece una versión remota diferente, una RPC ausente, cambios de origen/proyecto, bindings desconocidos o pruebas fallidas, detenerse y revisar; no sobrescribir otra publicación.

Desde `E:\Project_CAI_Market`, comandos **preparados, no ejecutados con publicación**:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = 'f2f2dcbac86bc1a805d13cc387c8a568'
$env:CLOUDFLARE_SEND_METRICS = 'false'
$env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
$env:WRANGLER_LOG_PATH = Join-Path (Get-Location).Path '.cache\worker-v1-preparation\wrangler-deploy.log'

npx --yes wrangler@4.152.0 deployments list --config worker/api/wrangler.jsonc --name cai-market-api

# SOLO DESPUÉS DE AUTORIZACIÓN EXPLÍCITA DEL USUARIO:
npx --yes wrangler@4.152.0 deploy --config worker/api/wrangler.jsonc --keep-vars --message 'CAI Market V1: RPC 005-008 y correccion Auth manual'
```

`--keep-vars` conserva la publishable remota; los dos valores públicos declarados coinciden con los ya configurados. No ejecutar `secret put/delete`, `versions secret`, SQL, comandos Pages ni cambios de permisos. Wrangler `deploy` publica inmediatamente: no confundirlo con `--dry-run` ni con una consulta. [Documentación oficial del comando](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

Después de publicar con autorización, guardar el nuevo version ID y ejecutar los probes públicos de solo lectura. Exigir health 200, token ausente 401, JWT ficticio 401, OPTIONS 204 y origen prohibido 403, con JSON/CORS/no-store correctos. El script existente también comprueba marcadores del frontend; mientras Pages siga antiguo puede continuar saliendo con código 1 aunque las cinco sondas API ya pasen: evaluar los resultados por componente, sin declarar publicada V1 completa. Comprobar de forma segura el login real y `/api/me` con una cuenta autorizada, sin imprimir JWT y sin registrar operaciones comerciales. Esa prueba real no se ejecutó durante esta preparación.

## Reversión preparada

Estado leído, sin despliegue gradual activo:

- Deployment actual: `3ad2af6e-5f14-4ddc-9396-bd0f0709b007`.
- **Version ID para rollback: `14169527-099c-420c-a2a1-9667a5271e3b`**, número 11, 100 % del tráfico. No confundirlo con el deployment ID.
- Fecha de versión: `2026-10-24T01:50:38.171696Z`. Disponibilidad confirmada en el listado de versiones.

Ante una regresión atribuible a la nueva versión, detener las verificaciones afectadas, guardar solo evidencia saneada y volver a esta versión si se ha autorizado esa reversión:

```powershell
npx --yes wrangler@4.152.0 rollback 14169527-099c-420c-a2a1-9667a5271e3b --config worker/api/wrangler.jsonc --name cai-market-api --message 'Reversion controlada del Worker V1'
npx --yes wrangler@4.152.0 deployments list --config worker/api/wrangler.jsonc --name cai-market-api
```

Confirmar que la versión anterior vuelve al 100 %, los bindings permanecen y health/CORS/no-token recuperan su contrato. La reversión del Worker **no revierte PostgreSQL, saldos, R2 ni operaciones ya confirmadas**; no ejecutar migraciones inversas ni restauraciones de base. El código anterior admite el esquema 001–008 porque no usa las tablas nuevas, pero devuelve el fallo conocido 503 con JWT ficticio y no ofrece los endpoints comerciales V1. No habilitar la interfaz V1 contra ese backend revertido. [Alcance oficial del rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Cambios y evidencia

Archivos añadidos por esta preparación:

- `tests/api/operations.spec.ts`: 21 pruebas de routing, parámetros, idempotencia, Auth/perfil, CORS, redirecciones y errores.
- `scripts/verify-worker-runtime.mjs`: 14 comprobaciones de runtime local, sin credenciales ni red remota del Worker.
- `supabase/checks/worker_v1_readiness.sql`: consulta exclusiva de metadatos, sin operaciones de negocio.
- Este informe, con enlaces de actualización en la guía de producción y README del Worker.

No se modificaron `worker/api/src/index.ts`, `catalog.ts` ni las migraciones aplicadas. La fijación local de `SUPABASE_URL` en Wrangler ya existía antes de esta revisión. No se eliminaron pruebas ni controles. Evidencia saneada local en `.cache/worker-v1-preparation/` (ignorada en Git): lecturas remotas, probes publicados, tests de créditos/runtime, revisión del artefacto y logs de dry-run. Nunca publicar archivos de credenciales ni logs globales de autenticación.

Riesgos pendientes: validación del login real y red desde el Worker publicado; seguimiento de 503/timeout tras el cambio; frontend publicado aún anterior; rollback devuelve la limitación conocida de Auth. Estos límites no requieren modificar Supabase. Publicar únicamente el Worker y realizar sus comprobaciones posteriores requiere la autorización explícita solicitada al usuario.
