# Worker V1 publicado: resultado de verificación

**Estado final: PUBLICADO, sin reversión.** Destino exclusivo: [cai-market-api](https://cai-market-api.brysof22.workers.dev), cuenta `f2f2dcbac86bc1a805d13cc387c8a568`, Supabase original `sauoekefntzxhqxycdgo`.

- **Version ID nueva:** `84dea860-d785-4387-994b-9bac21126178`, activa al 100 %.
- Deployment ID: `e0c5538e-bd41-4b37-b375-ef3cbb1127fe`.
- Fecha: **25/10/2026, aproximadamente 22:09 Colombia** (`2026-10-26T03:09Z`). Confirmación posterior de versión/bindings: 22:09:56 Colombia.
- Versión anterior disponible para reversión: `14169527-099c-420c-a2a1-9667a5271e3b`.
- Rama local `release/cai-market-v1`, HEAD `385eb8a`, sin commit ni fusión nuevos.

La autorización del usuario incluyó el despliegue controlado del Worker y la reversión ante una regresión nueva. Se completó la publicación y sus verificaciones. **Cloudflare Pages no se publicó ni modificó.**

## Condiciones previas y publicación

Se releyeron cuenta, Worker, configuración, bindings, versión activa y disponibilidad de la versión de reversión. Coincidieron con la preparación aprobada. Se renovó la sesión OAuth local de Wrangler porque había caducado; no se crearon usuarios ni se renovaron roles de Supabase.

Una consulta de metadatos mediante el endpoint oficial de Supabase de solo lectura confirmó historial 001–008, cuatro RPC presentes, firmas/permisos correctos, seis tablas nuevas, RLS/propietarios previstos y ausencia de CREATE para `pos_owner` en `pos`/`public`. Data API continúa exponiendo `public,graphql_public`, sin `pos`.

Se repitió el dry-run con Wrangler **4.152.0**. El bundle conservó los 13.840 bytes y SHA-256 aprobado: `c8f102761c34c45940ceafa67cf93f03e729e52c7a53d6b609d8d652b8a40f6d`. Las fuentes del Worker y las migraciones no se modificaron. Las pruebas de preparación siguen documentadas en [PREPARACION_WORKER_V1_20261025](PREPARACION_WORKER_V1_20261025.md): 103 API, 83 SQL, 14 workerd, TypeScript y lint aprobados. No se repitieron suites sin cambios de implementación; sí se reconstruyó y comprobó el artefacto antes de publicar.

Se ejecutó el comando preparado utilizando la instalación local de esa versión de Wrangler:

```powershell
node .cache/npm/_npx/c943b712072b77c4/node_modules/wrangler/bin/wrangler.js deploy --config worker/api/wrangler.jsonc --keep-vars --message 'CAI Market V1: RPC 005-008 y correccion Auth manual'
```

Cuenta fijada mediante `CLOUDFLARE_ACCOUNT_ID`, métricas de CLI desactivadas y logs del CLI en `.cache/worker-v1-deployment/`. Resultado: exit 0, upload correcto, startup 1 ms, versión nueva publicada. No se ejecutó ningún comando Pages ni SQL de escritura.

## Variables y bindings conservados

Se capturó una huella canónica de todos los bindings antes y después de publicar. Las dos huellas son exactamente iguales: `be14055d6a7fcb40ec4a75d348b013f339f52a54370e03e9c12ff9f31d5f2d86`.

| Binding | Resultado |
| --- | --- |
| `SUPABASE_URL` | Conservado, proyecto original |
| `ALLOWED_ORIGIN` | Conservado, `https://project-market.pages.dev` |
| `SUPABASE_PUBLISHABLE_KEY` | Conservada exactamente, valor no incluido en evidencias públicas |
| `MEDIA` | Conservado, bucket `cai-market-media`; ninguna operación R2 |

No había bindings secretos `secret_text`; no se añadieron, borraron ni sustituyeron credenciales. Fecha de compatibilidad `2026-10-23`, workers.dev y configuración previa de URLs de versión conservados. No se creó un entorno Preview. La lectura del código publicado confirmó `manual`, ausencia de `redirect: error` y presencia de catálogo/operaciones.

## Comprobaciones sobre producción

Las **13 comprobaciones** siguientes pasaron, con CORS y `Cache-Control: no-store` esperados:

| Comprobación | Resultado |
| --- | --- |
| GET `/health`, sin Origin y con Origin Pages | 200, JSON `status: ok` |
| GET `/api/me`, sin token | 401 `UNAUTHORIZED` |
| GET `/api/me`, JWT ficticio `aaa.bbb.ccc` | 401 `UNAUTHORIZED`, sin `AUTH_UNAVAILABLE` |
| GET `/api/me`, Bearer malformado | 401 `UNAUTHORIZED` |
| OPTIONS de `/api/me` para GET | 204, origen exacto y método previsto |
| OPTIONS de `/api/catalog` y `/api/operations` para POST | 204, origen exacto y método previsto |
| Origin ajeno | 403 `ORIGIN_FORBIDDEN`, sin autorización CORS |
| POST vacío sin JWT a catálogo y operaciones | 401 antes de interpretar el cuerpo o invocar RPC |
| POST vacío con JWT ficticio a catálogo y operaciones | 401 tras el rechazo de Auth, sin llegar a RPC |

Las solicitudes POST vacías solo comprobaron la barrera de autenticación: no incluyeron una acción comercial, datos, clave de idempotencia ni JWT válido. No se ejecutaron ventas, abonos, devoluciones, ajustes, movimientos de caja ni otras operaciones comerciales de prueba.

También pasaron las cinco sondas API del script existente `check-deployment.mjs`. Su salida global continuó siendo 1 **únicamente porque el bundle antiguo de Pages aún no contiene los marcadores V1**. Se conservaron sus expectativas y se evaluaron los componentes por separado. No es una regresión del Worker ni motivo para restaurar el fallo anterior. El archivo público de frontend siguió siendo `/assets/index-Db7PYJLl.js`.

## Autenticación, comunicación con Supabase y registros

Una sesión temporal de tail filtrada por la versión nueva capturó **11 invocaciones**, todas `outcome: ok`, **cero excepciones no manejadas y cero resultados críticos** durante la ventana observada, aproximadamente **22:11:49–22:12:13 Colombia**. Se cerró la sesión temporal y se eliminó su recurso de tail; no se habilitó observabilidad persistente ni se cambió la configuración de logs.

Se proyectaron en memoria exclusivamente los campos permitidos de `auth_diagnostic`; no se imprimieron ni guardaron envelopes brutos que pudieran contener encabezados, URLs de solicitud o excepciones originales. Dos diagnósticos capturados mostraron:

| Fase | Duración | Estado de Supabase | Excepción | Timeout |
| --- | --- | --- | --- | --- |
| `auth_fetch` | 202 ms | 403 | null | false |
| `auth_fetch` | 61 ms | 403 | null | false |

Esto demuestra que **el Worker publicado obtuvo respuestas HTTP de Supabase Auth** y normalizó el rechazo de un JWT ficticio a 401. El TypeError inmediato anterior no apareció en este camino publicado. Las observaciones se limitan a la ventana capturada; no se afirma haber auditado todo el historial de logs.

**Límite pendiente:** no había una sesión real de prueba autorizada disponible en el arnés; las fixtures contienen únicamente tokens ficticios y no se utilizaron como sesiones reales. No se crearon usuarios, no se buscaron contraseñas y no se sustituyó la identidad por credenciales administrativas. Por ello no se certifica todavía el camino completo con usuario válido, Auth → `cai_current_profile()` → respuesta de perfil 200. Las RPC existentes y sus permisos sí quedaron confirmados por lectura de metadatos.

## Supabase y alcance final

No ejecuté modificaciones de datos, estructuras, propietarios, permisos ni migraciones en Supabase. La comprobación posterior, con `transaction_read_only=on`, conserva exactamente definiciones/permisos de las cuatro RPC, historial y esquemas de Data API de la captura previa. RLS/propietarios continúan correctos. No se restauró ningún respaldo.

No se identificó una regresión atribuible al despliegue, por lo que **no se ejecutó rollback**. El Worker permanece publicado al 100 % en la versión indicada. La versión anterior continúa disponible, pero recuperarla devolvería el fallo conocido `AUTH_UNAVAILABLE` y retiraría los endpoints V1; no se revirtió un despliegue satisfactorio por esa limitación histórica.

Evidencias locales saneadas en `.cache/worker-v1-deployment/` (ignoradas en Git): snapshots de versiones/bindings, salida del deploy, sondas públicas, verificaciones con tail proyectado, comparación de metadatos y confirmación del código. No se incluyeron secretos en este informe.

**Trabajo detenido antes de publicar el frontend**, conforme a la autorización. Pages, Supabase, ramas Git y datos comerciales no se modificaron en esta publicación del Worker. Queda pendiente la validación con sesión real y cualquier publicación de frontend mediante una instrucción posterior.
