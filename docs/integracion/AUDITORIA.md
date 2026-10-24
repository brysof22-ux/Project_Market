# Integración inicial: auditoría y publicación pendiente

Revisión del 23 de octubre de 2026. Alcance: identidad real y lectura del perfil propio, conservando la interfaz actual. No se ejecutaron SQL remoto, despliegues, operaciones R2 ni mensajes WhatsApp.

## Estado encontrado

El código local ya implementa Supabase Auth → Worker → RPC del perfil. La versión pública no coincide con él. Las comprobaciones HTTP públicas del 23/10/2026 devolvieron:

| Solicitud | Publicado | Contrato local esperado |
| --- | --- | --- |
| GET /health | 200, texto, sin no-store | 200, JSON `{"status":"ok"}`, no-store |
| GET /api/me sin token | 200, texto | 401, JSON de error |
| GET /api/me con JWT deliberadamente inválido | 200, texto | 401, JSON de error |
| OPTIONS /api/me desde Pages | 200, sin permisos CORS | 204, origen exacto y GET/OPTIONS |
| GET /api/me desde origen ajeno | 200, texto | 403, sin Allow-Origin |

No se recibió un perfil en esas respuestas; estos resultados **no prueban una filtración de perfiles**. Sí impiden dar por operativa la integración publicada. El HTML de Pages responde 200, pero su bundle principal no contiene la URL esperada del Worker ni `/api/me`: es un indicio de un frontend anterior, no una comprobación de sus variables en el panel de Cloudflare.

`npm run check:deployment` reproduce estas consultas de solo lectura, imprime únicamente metadatos y devuelve código 1 si el contrato publicado falla. No acepta credenciales ni JWT reales. El informe fechado está en `diagnostico-remoto.json`. Un resultado correcto de ese script tampoco reemplaza el ensayo con una cuenta real.

En `.env.local` guardado en disco faltan `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`; `VITE_API_URL` sí está presente. No se modificaron ni recuperaron claves. Guardar ambas variables públicas del mismo proyecto antes de iniciar Vite o compilar el artefacto para Pages.

`npm run check:frontend-config` valida la configuración pública de producción sin imprimir sus valores. Actualmente falla por esas dos variables ausentes. La compilación puede pasar aun sin ellas: **el dist generado durante esta revisión no está listo para publicar**. Completar variables, validar y reconstruir.

## Resultado de la auditoría SQL 005

**No se encontró una vía de lectura de otro usuario ni de modificación de roles en la función revisada.** Aprobación técnica condicionada a verificar los permisos efectivos del proyecto alojado, que no se consultaron con credenciales de administrador.

- `public.cai_current_profile()` no recibe parámetros. No existe `p_actor` ni ID proporcionado por React. Devuelve exclusivamente `id`, `display_name`, `role`, `active` del registro activo cuyo ID coincide con `auth.uid()`.
- Exige `session_user = authenticator`, claim `role = authenticated`, sujeto coincidente y expiración vigente. Los GUC de una conexión SQL directa no autorizan la llamada. Auth/PostgREST verifican criptográficamente el JWT; la lectura de claims en SQL por sí sola no verifica firmas.
- Es `STABLE SECURITY DEFINER`, sin escrituras ni SQL dinámico, con referencias cualificadas y `search_path = pg_catalog, pg_temp`. El propietario `pos_owner` es NOLOGIN, sin privilegios administrativos. Como posee las tablas puede eludir RLS: el predicado de identidad explícito es imprescindible.
- Revoca EXECUTE a PUBLIC, anon, service_role y roles técnicos; lo concede a authenticated. No concede SELECT/UPDATE sobre tablas. El propietario conserva sus privilegios propios.
- Tras el fallo remoto comunicado, se corrigió 005 pendiente: Supabase alojado no permite a postgres delegar USAGE de auth. Un puente privado `pos.current_profile_auth_uid()` propiedad del migrador ejecuta exclusivamente `auth.uid()`, con EXECUTE para pos_owner. No modifica permisos de auth ni requiere superusuario. El migrador conserva su acceso existente a auth, crea el helper en pos y transfiere solo la RPC pública mediante CREATE temporal en public.
- No modifica `pos.require_staff`, las reglas financieras ni las cuatro migraciones previas. La edición de 005 solo es aplicable si no se aplicó correctamente; los guards rechazan historial aplicado u objetos previos. [Diagnóstico, SQL, comprobación de estado parcial y comandos](MIGRACION_005.md).

Preparado `supabase/checks/current_profile_audit.sql`: consultas de catálogo dentro de transacción READ ONLY, para examinar definición, propietario, sobrecargas, EXECUTE, membresías, RLS y funciones SECURITY DEFINER públicas. Si 005 aún no existe, utilizar primero `current_profile_preflight.sql`; la auditoría posterior presupone que existe. Ninguno se ejecutó remotamente. Las migraciones se cargaron únicamente en PGlite local con roles de prueba.

## Riesgos y límites que deben conservarse visibles

1. **Código publicado distinto:** hay que publicar el Worker local y reconstruir Pages; disponer de variables remotas no actualiza el código.
2. **Binding ausente:** Wrangler no declaraba MEDIA. `keep_vars` conserva variables, no sustituye la configuración de recursos. Se añadió explícitamente `r2_buckets` para `cai-market-media`; sin `remote: true`, sin acceso público y sin rutas de carga todavía. Comparar cualquier otro binding/ruta remoto antes del despliegue.
3. **Esquema privado:** 004 concede EXECUTE a authenticated para nueve operaciones de empleados, pero no para helpers administrativos ni scheduler; las tablas siguen sin lectura directa. Un comentario histórico de 004 propone exponer pos: **no seguirlo**. Mantener pos fuera de Data API. No se editó la migración aplicada; futuros endpoints necesitarán wrappers públicos específicos y auditados, no exponer todo pos.
4. **Contexto JWT:** otra RPC pública capaz de ejecutar SQL arbitrario, cambiar claims o asumir roles invalidaría este límite de confianza. Revisar todo el catálogo público y las membresías reales, no solo 005. No entregar credenciales de authenticator/pos_owner al Worker.
5. **Roles:** `/api/me` permite obtener el perfil propio de cualquier empleado activo (admin, supervisor o cashier); no es un endpoint administrativo. Los futuros endpoints deberán validar cada permiso en backend. El selector de roles de demostración no autoriza operaciones remotas.
6. **Persistencia de sesión:** el SDK mantiene tokens en localStorage para restaurar sesión. Esto conserva el comportamiento existente, pero no cumple la política futura de limitar localStorage a preferencias no sensibles del documento de requisitos. Sigue pendiente acordar un BFF/sesión HttpOnly y medidas contra XSS antes del uso comercial. No se sustituyó por una falsa sesión local.
7. **Alcance de las pruebas:** mocks de Auth/API y PGlite no certifican firma real, ACL del Supabase alojado ni concurrencia entre conexiones PostgreSQL independientes. No se dispone de contraseña del administrador y no se realizó login remoto válido. Tampoco se inspeccionó la configuración privada de la cuenta Cloudflare.

## Validación del Worker y frontend

El Worker valida el Bearer mediante `/auth/v1/user` de Supabase y reutiliza **el mismo JWT** en la RPC, con clave publishable. Comprueba que el ID retornado coincida con Auth, exige perfil activo y proyecta los cuatro campos. No utiliza service_role, contraseña PostgreSQL, ID del navegador ni un rol de la UI. Rechaza redirecciones, limita tiempos de espera y sanea errores.

CORS solo permite `https://project-market.pages.dev`, exacto. Rechaza dominios parecidos, previews no aprobadas, origen null y vacío. Los clientes sin Origin requieren JWT igualmente. Desarrollo local usa el origen explícito de `.dev.vars`, sin añadir localhost a producción. `/health` no consulta Supabase ni R2 y no certifica disponibilidad de esos servicios.

`src/lib/api.ts` obtiene `VITE_API_URL` y la sesión real del SDK. El cliente HTTP adjunta el Bearer; el proveedor Auth bloquea la app hasta verificar Auth y `/api/me`. Maneja errores, restauración, expiración y logout sin utilizar perfiles demo para permitir acceso. No se cambiaron componentes visuales ni QR.

## Pruebas

Ejecutar secuencialmente:

```powershell
npm run check:api
npm run test:api
npm run check:credit
npm run test:credit
npm run build
npm run lint
npm run test:e2e -- --workers=1 --max-failures=1
npx --yes wrangler@4.152.0 deploy --dry-run --config worker/api/wrangler.jsonc --outdir worker/api/.dry-run
npm run check:deployment
```

Resultados: **127 pruebas aprobadas** (32 API/configuración, 59 SQL y 36 Chromium), TypeScript, build y lint correctos; dry-run de Wrangler 4.152.0 correcto, con MEDIA declarado. Además se inició workerd local con R2 local y se verificaron seis solicitudes HTTP: health 200 con JSON, sin JWT 401, Bearer malformado 401, origen ajeno 403, preflight autorizado 204 y POST 405; todas con no-store. Se detuvo el servidor al terminar. No se consultó Supabase ni el bucket remoto en ese ensayo.

Las pruebas añadidas comprueban el binding/origen/nombre existentes, lectura propia de un cajero, rechazo de claims de rol privilegiado, prohibición de SELECT/UPDATE directo de perfiles y lista exacta de funciones privadas ejecutables por authenticated. La regresión financiera conserva la separación de efectivo, transferencias y cartera y los vencimientos del día 28. WhatsApp sigue simulado, sin transporte real ni cron desplegado. Las comprobaciones de configuración frontend y del contrato publicado fallan por los pendientes descritos, no se contabilizan como aprobadas.

Archivos cambiados en esta revisión: `worker/api/wrangler.jsonc`, tipo Env de `worker/api/src/index.ts`, fixture `tests/api/worker.spec.ts`, nuevas pruebas `tests/api/configuration.spec.ts` y casos adicionales de `tests/credit/current-profile.spec.ts`; `package.json`, los dos scripts `scripts/check-*.mjs`, `supabase/checks/current_profile_audit.sql`, esta auditoría, su diagnóstico JSON y `worker/api/README.md`. Se regeneró dist para comprobar compilación; no se debe publicar ese artefacto sin reconstruir con las variables reales. No se modificaron las cinco migraciones ni componentes visuales.

## Comandos de publicación (no ejecutados)

Primero completar `.env.local` con las tres variables públicas de `.env.example`, confirmar en Cloudflare Pages las mismas variables para Production y verificar que 005 está aplicada exactamente una vez y que pos no está expuesto. Revisar manualmente la auditoría SQL; cualquier cambio de permisos requiere autorización aparte.

Desde PowerShell en `E:\Project_CAI_Market`:

```powershell
Set-Location E:\Project_CAI_Market
# Lectura: verificar cuenta, Worker y proyecto existentes. Autenticarse si hace falta.
npx --yes wrangler@4.152.0 whoami
npx --yes wrangler@4.152.0 deployments list --config worker/api/wrangler.jsonc --name cai-market-api
npx --yes wrangler@4.152.0 pages project list
```

Detenerse si la cuenta o `project-market` no coinciden. Confirmar en el panel la rama de producción del proyecto existente; no se presupone que sea main. Conservar un registro de la versión/despliegue previo para rollback. SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY ya están configuradas en el Worker: no es necesario sobrescribirlas.

Solo después de autorizar el despliegue:

```powershell
# Mismo Worker, mismo bucket. No crea un Worker con otro nombre.
npx --yes wrangler@4.152.0 deploy --config worker/api/wrangler.jsonc
if ($LASTEXITCODE -ne 0) { throw 'Falló el despliegue del Worker' }

# Vite incorpora las variables al compilar; Pages deploy no recompila dist.
# Ejecutar después de guardar las variables reales en .env.local.
npm run check:frontend-config
if ($LASTEXITCODE -ne 0) { throw 'Completar variables antes de publicar' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación' }

# Introducir la rama de producción que figura en el panel de Pages.
$pagesProductionBranch = Read-Host 'Rama de producción existente de project-market'
if ([string]::IsNullOrWhiteSpace($pagesProductionBranch)) { throw 'Falta confirmar la rama' }
npx --yes wrangler@4.152.0 pages deploy dist --project-name project-market --branch "$pagesProductionBranch"
if ($LASTEXITCODE -ne 0) { throw 'Falló la publicación de Pages' }
npm run check:deployment
```

Son comandos manuales preparados, no un script que se haya ejecutado. Nunca ejecutar reset ni reaplicar las migraciones 001–004. Si 005 falta, su aplicación debe revisarse y autorizarse por separado. Los bindings R2 se configuran en el Worker, no en el bundle estático de Pages. El bucket está enlazado, pero las cargas reales aún no están implementadas.

Si C: carece de espacio, usar antes la configuración de caché/temporales en E: documentada en `worker/api/README.md`.

## Procedimiento para probar el login real

1. Tras la publicación autorizada, ejecutar `npm run check:deployment`. Esperar cinco comprobaciones correctas y los dos indicadores del bundle presentes. `/health` debe devolver el JSON documentado; `/api/me` sin JWT debe dar 401.
2. Abrir `https://project-market.pages.dev` en una ventana privada. Abrir Network y entrar con el correo/contraseña reales del administrador existente, introducidos únicamente en el formulario.
3. Verificar la llamada de login a Supabase y `GET /api/me` al Worker. La segunda debe responder 200 con solo id, display_name, role y active del administrador. No copiar el Bearer, exportar HAR con credenciales ni mostrarlo en capturas.
4. Actualizar la página: debe restaurar y verificar la sesión. Cerrar sesión: los módulos privados desaparecen; recargar debe mantener cerrado el acceso. Contraseña incorrecta debe mostrar un error sin entrar.
5. Para probar 403 usar una cuenta de prueba sin perfil o inactiva, provisionada previamente por un administrador. No desactivar la única cuenta administradora ni utilizar registros financieros. Debe bloquearse el acceso. Un token vencido/no renovable debe exigir autenticación de nuevo.
6. Cambiar el rol local de demostración no debe modificar `/api/me` ni el rol real en PostgreSQL. No se exige permiso admin para consultar el propio perfil activo de un cajero.

## Qué sigue siendo demo y siguiente fase

**Real en el código local:** Supabase Auth, verificación remota de usuario, consulta del perfil propio mediante Worker/RPC, restauración y cierre de sesión. **Pendiente de publicar y validar de extremo a extremo con la cuenta real.**

**Demo:** catálogo, categorías, inventario, ventas y POS, movimientos de caja, cartera/abonos en la UI, indicadores/reportes, clientes, proveedores y administración de vendedores. Los QR fijos, comprobaciones de rol de esa interfaz, confirmaciones manuales e historial de transferencias son locales (IndexedDB); no hay verificación bancaria ni subida de imágenes a R2. Las migraciones financieras existen, pero esas operaciones todavía no están conectadas al frontend mediante el Worker. WhatsApp no envía mensajes reales.

Siguiente fase: contratos y persistencia real de productos/categorías/unidades, inventario y vendedores, con roles del perfil real y permisos backend. Los requisitos adjuntos añaden unidades fraccionarias, costo promedio ponderado y costo histórico: revisar tipos de cantidades (actualmente enteros en el modelo inicial), conversiones y transacciones antes de crear nuevas migraciones. No exponer pos para acelerar esa conexión ni reutilizar roles demo como autorización. PDFs, cierre de caja y documentos no DIAN quedan para fases posteriores.

## Referencias oficiales

- [Supabase: SECURITY DEFINER, search_path y permisos de funciones](https://supabase.com/docs/guides/database/functions).
- [Cloudflare: Wrangler, keep_vars y recursos](https://developers.cloudflare.com/workers/wrangler/configuration/).
- [Cloudflare: R2 mediante bindings de Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
- [Cloudflare: publicación de Pages con Wrangler](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).
