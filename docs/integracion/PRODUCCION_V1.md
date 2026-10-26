# CAI Market V1: lote preparado para producción

**Frontend, 25/10/2026:** preparación aprobada (103 API, 41 UI, TypeScript/lint/build, 7 CSP). Se añadió únicamente `VITE_API_URL` a producción de Pages sin desplegar; main sigue en `27aa8c7b...`. Commit/integración/publicación pendientes de autorización. Ver [lote, publicación y reversión](PREPARACION_PAGES_V1_20261025.md).

**Estado vigente, 25/10/2026 22:12 Colombia:** Worker V1 publicado y comprobado, versión `84dea860-d785-4387-994b-9bac21126178`, con JWT inválido rechazado como 401 y sin reversión. Ver [resultado](RESULTADO_WORKER_V1_20261025.md). Pages permanece sin cambios; login con sesión real y frontend siguen pendientes. Las etapas preparatorias descritas debajo son históricas.

**Backend, 25/10/2026:** preparación del Worker V1 completada con lecturas remotas, 103 pruebas API, 83 SQL, 14 de workerd y dry-run aprobados. Despliegue pendiente de autorización; ver [informe y reversión](PREPARACION_WORKER_V1_20261025.md). La publicación completa y el frontend siguen pendientes.

**Actualización 25/10/2026, 19:14 Colombia:** respaldo recuperable verificado y migraciones 006–008 aplicadas en Supabase original con autorización, TLS verify-full y restauración exacta de la barrera de ACL. Ver [resultado definitivo](RESULTADO_PRODUCCION_006_008_20261025.md). Los bloqueos de respaldo/SQL descritos en la preparación histórica siguiente quedaron resueltos. Worker, Pages e integración en main permanecen pendientes; no se desplegaron en esta ejecución.

24/10/2026. Esta guía sustituye la propuesta anterior de publicar una Preview. No utiliza cai-market-preview ni crea un proyecto Supabase adicional. La restauración de ensayo del respaldo y las bases efímeras de pruebas locales no son un entorno Preview de la aplicación.

## Destinos únicos

| Componente | Destino |
| --- | --- |
| GitHub | brysof22-ux/Project_Market; origen de V1 release/cai-market-v1; producción main |
| Pages | cai-market; https://project-market.pages.dev; npm run build; dist |
| Worker | cai-market-api; https://cai-market-api.brysof22.workers.dev |
| Supabase | sauoekefntzxhqxycdgo; https://sauoekefntzxhqxycdgo.supabase.co |

No se ha integrado main, hecho un commit nuevo, aplicado SQL remoto ni desplegado Worker/Pages durante esta preparación. La autorización para preparar este lote no es autorización para ejecutar esas acciones.

## Estado real observado y bloqueos

- El operador confirmó expresamente que **no existe respaldo de Supabase**. No está habilitada la aplicación de migraciones.
- Se encontró Docker Desktop instalado, pero su motor Linux no estaba disponible. psql, pg_dump, pg_restore y Supabase CLI no se encontraron en PATH; eso no prueba que no estén instalados en otra ubicación. No se instalaron herramientas ni arrancaron servicios.
- Estado SQL comunicado por el operador: 001–005 registradas, 006–008 no registradas y objetos principales nuevos ausentes. No se consultó SQL remoto en esta preparación; se necesita una comprobación fresca antes de aplicar.
- Inspección de Cloudflare solo mediante GET: Pages tiene main como rama de producción y el Supabase original; falta VITE_API_URL en las variables de producción. La clave publishable está configurada, sin imprimirse ni copiarse al repositorio.
- El Worker publicado apunta al Supabase original y aún contiene redirect:error. No contiene las RPC comerciales cai_catalog/cai_operations/cai_report en su código actual. /health devolvió 200, sin token /api/me devolvió 401, JWT ficticio devolvió 503: **la comprobación publicada de autenticación sigue fallando**. CORS permitido/rechazado y Cache-Control pasaron las sondas públicas.
- Las sondas del frontend publicado todavía no identifican el cliente V1 de /api/me y la API esperada en su bundle. Son indicadores de diagnóstico, no una certificación funcional.

## Autenticación: causa y corrección preparada

Cloudflare workerd no admite redirect:error al construir Request. La excepción ocurre antes de enviar la petición; Node/mocks aceptan esa opción y por eso no la detectaban. [API Request de Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/request/).

La rama V1 ya corrige las llamadas del Worker a manual, conserva JWT original/publishable, timeout y perfil activo propio, y rechaza 3xx mediante !response.ok, sin seguir Location. Auth no usa cache; las RPC y respuestas públicas conservan no-store. JWT falso/rechazado por Auth produce 401; fallos de transporte/servicio conservan códigos saneados. Los logs temporales solo contienen datos técnicos permitidos.

Se reprodujo de nuevo en workerd local real, con el harness independiente, sin RPC ni JWT real:

| Prueba | Resultado |
| --- | --- |
| Request manual | Construcción correcta |
| Request error | TypeError en fase request, sin respuesta HTTP |
| Manual + AbortSignal.timeout | Construcción correcta |
| Manual + timeout + publishable del proyecto original + JWT ficticio | Respuesta HTTP 403 de Supabase, sin TypeError ni timeout |
| Mismas opciones con redirect:error | TypeError antes de red |

Ese 403 demuestra conectividad hasta Auth y no una sesión válida. La prueba usa la instrumentación saneada; no conserva cuerpos/encabezados ni datos de usuarios. El servidor local se detuvo. La corrección está preparada localmente, **no desplegada**. Después de desplegar se debe verificar JWT ficticio→401 y sesión real→perfil propio.

## Frontend y Worker preparados

- shared/production-config.ts fija los tres destinos públicos autorizados. El build de producción rechaza URL de otro Supabase, otra API, claves secret/service_role, plantillas y variables VITE_ adicionales. Los errores solo muestran nombres de variables. La publishable se comprueba por formato; no se afirma validación criptográfica ni pertenencia del proyecto por ese chequeo.
- npm run check:frontend-config usa scripts/check-frontend-config.mts y Node con soporte de eliminación de tipos. La compilación de Vite aplica la misma validación, aunque Pages solo ejecute npm run build. El runtime observado de Pages Node 22.23.4 la soporta; registrar/preservar versiones de herramientas en la publicación.
- PREVIEW_BLOCKED se conserva exclusivamente para release/cai-market-v1. **No afecta a main**: el build simulando main pasó. No se quita ese control para publicar otra rama ni se configura Preview.
- CSP se limita al Supabase original y Worker definitivo; conserva las demás cabeceras. Todas las pantallas V1 y sus permisos permanecen conectados a Worker/RPC, sin fuente de datos demo en rutas comerciales.
- Wrangler fija SUPABASE_URL al proyecto original, ALLOWED_ORIGIN al dominio definitivo y conserva keep_vars y el binding MEDIA. No se añade una clave al archivo; la publishable existente se mantiene remota. No se necesitan credenciales administrativas en navegador.
- Endpoints: GET /health, GET /api/me; POST /api/catalog y /api/operations, con report encaminado a cai_report. Cada operación valida sesión/perfil, datos/tamaño, autorización SQL e idempotencia. No existe un endpoint para SQL arbitrario ni para elegir actor o esquema.
- El Worker V1 completo requiere 006–008. No publicarlo sobre la base que solo tiene 001–005, aunque /api/me sea compatible con 005. La ausencia de una RPC provoca error, no un fallback ficticio ni acceso directo a tablas.

## Respaldo: siguiente paso, obligatorio

Primero habilitar las herramientas locales y recuperar una conexión administrativa autorizada desde Connect del proyecto original. No compartir la contraseña ni introducirla literalmente en el historial de PowerShell; utilizar entrada local protegida/credenciales de cliente. No resetear contraseñas como parte de este procedimiento.

Primer diagnóstico del operador, sin conexión a la base:

```powershell
docker version
```

Abrir Docker Desktop si su motor no responde y volver a comprobarlo. Antes de exportar, confirmar versión PostgreSQL del origen y fijar versiones del cliente/CLI compatibles. Seguir el [procedimiento oficial de backup/restore Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) con roles, schema, data (--data-only --use-copy) e historial separado (--schema supabase_migrations). No asumir cobertura automática de Auth: verificar auth.users, identidades y dependencias del perfil, estado de secuencias, roles/ACL y funciones. Los nombres de archivo previstos son roles.sql, schema.sql, data.sql, history_schema.sql e history_data.sql.

La cuenta usada debe leer lo necesario para un respaldo completo; si hay error de permisos o un esquema relevante excluido, detenerse, no aceptar un dump incompleto. No usar service_role del frontend para respaldar PostgreSQL.

Guardar fuera del repositorio, con cifrado/restricción de acceso y una segunda copia independiente. Registrar hashes SHA-256, fecha, project ref y versiones. Detener escritores comerciales, jobs e integraciones durante la captura para que los archivos separados correspondan al mismo estado operativo. Archivos SQL y datos Auth son sensibles.

Restaurar realmente en Supabase local aislado compatible, en otra carpeta sin las migraciones pendientes del repositorio. No restaurar sobre producción ni iniciar el stack desde este checkout aplicando accidentalmente 006–008. Validar filas originales, saldos, UUID Auth/perfiles, secuencias, FK/CHECK, triggers habilitados, RLS, propietarios/ACL e historial. Cualquier adaptación por objetos administrados debe ser revisada; no ignorar errores de propietario o permisos. Solo un ensayo de restauración satisfactorio acredita recuperación. Hash/tamaño/código de salida por sí solos no bastan.

Storage/R2 físicos, secretos/configuración de Auth/SMTP/Data API y despliegues Cloudflare no están cubiertos automáticamente por PostgreSQL: inventariarlos aparte. Conservar un punto de recuperación reciente; una restauración vieja puede perder operaciones posteriores.

## SQL: lote sin modificaciones

Se mantienen los archivos 006–008 revisados, sin modificar 001–005 ni datos existentes. Detalles de permisos, restricciones y dependencias: PREPARACION_006_008.md. La sustitución de credit_charge_balances en 007 es el cambio más sensible: con devoluciones vacías, los saldos originales deben permanecer iguales.

```text
006 SHA256 9009E00E84822B795FEC8D6C9A5AC60F6C40042D61287B2271343FC2606E4237
007 SHA256 D11B144C9C009EA6AE528E76A9AEC5B6828DECBC2119A83B34CB6A8C92704B8F
008 SHA256 FA463CCF22DB5ED6E66A5290053A24F854181E27BF362A751F26D7104B36F08B
```

Nuevos controles preparados y probados localmente:

- supabase/checks/v1_production_preflight.sql: READ ONLY, exige historial 001–005, ausencia de 006–008 y de restos (columnas, índices, tablas, funciones/sobrecargas, trigger), permisos de SET ROLE/GRANT, propietarios/RLS y dependencias. Imprime la vista y ACL predeterminadas para revisión. No certifica por sí solo que Data API mantenga pos privado ni que todas las definiciones remotas sean idénticas.
- supabase/checks/v1_financial_baseline.sql: READ ONLY, SET LOCAL ROLE pos_owner dentro de la transacción, cuenta/importes de libros originales, inventario, cartera y controles de totales/no negativos. Guardar resultados antes y después **en privado**, durante mantenimiento. Las agregaciones complementan la comparación de filas originales del respaldo; no la sustituyen.
- supabase/checks/v1_preflight.sql: auditoría posterior general de ACL/propietarios/RLS e historial. El preflight estricto anterior es solo para ANTES de 006: debe abortar después de aplicar.

Configurar psql con host/puerto/usuario copiados de Connect ORIGINAL, base postgres y TLS. Para conexión directa, el host es db.sauoekefntzxhqxycdgo.supabase.co; si la red no soporta IPv6 usar pooler de sesión del mismo proyecto con usuario correcto. No usar pooler de transacciones. Nombre de base postgres no demuestra identidad de proyecto.

Consultas preparadas de solo lectura; no se ejecutaron remotamente:

```powershell
psql -X -W -v ON_ERROR_STOP=1 -f supabase/checks/v1_production_preflight.sql
if ($LASTEXITCODE -ne 0) { throw 'DETENER: preflight no aprobado' }
psql -X -W -v ON_ERROR_STOP=1 -f supabase/checks/v1_financial_baseline.sql
if ($LASTEXITCODE -ne 0) { throw 'DETENER: línea base financiera no verificada' }
```

## Secuencia de ejecución futura y autorizaciones

1. **Respaldo restaurado**, línea base original y preflight completo aceptados. Resolver diferencias de definiciones/ACL y ensayar concurrencia en PostgreSQL local con conexiones independientes, sin cuentas/datos reales. Los fixtures PGlite no acreditan esa concurrencia.
2. Solicitar autorización explícita de 006→007→008, sobre el proyecto original y hashes anteriores. Ventana de mantenimiento, un operador, sin otros escritores/migradores. No procede solicitar ejecución mientras el respaldo no exista.
3. Aplicar cada archivo COMPLETO por separado. Ejemplo preparado, NO EJECUTADO:

```powershell
psql -X -W -v ON_ERROR_STOP=1 --command="SET lock_timeout='5s'; SET statement_timeout='120s';" --file=supabase/migrations/20261023000600_catalog.sql
if ($LASTEXITCODE -ne 0) { throw 'DETENER: 006 no confirmada; no registrar ni continuar' }
# Validar 006 y registrar solo su versión antes de continuar con 007.
psql -X -W -v ON_ERROR_STOP=1 --command="SET lock_timeout='5s'; SET statement_timeout='120s';" --file=supabase/migrations/20261023000700_operations.sql
if ($LASTEXITCODE -ne 0) { throw 'DETENER: 007 no confirmada; no registrar ni continuar' }
# Validar 007 y registrar solo su versión antes de continuar con 008.
psql -X -W -v ON_ERROR_STOP=1 --command="SET lock_timeout='5s'; SET statement_timeout='120s';" --file=supabase/migrations/20261023000800_reports.sql
if ($LASTEXITCODE -ne 0) { throw 'DETENER: 008 no confirmada; no registrar ni continuar' }
```

Los archivos ya contienen BEGIN/COMMIT; no agregar un BEGIN exterior ni --single-transaction. No ejecutar todo este bloque sin las revisiones intermedias. Ante timeout/error/desconexión, inspeccionar estado real antes de reintentar. Un resultado ambiguo alrededor del COMMIT no autoriza repetir ni marcar aplicada.

4. Si se usó psql/SQL Editor, el historial no se registra automáticamente. Usar el mecanismo CLI ya adoptado, vinculado expresamente al project ref ORIGINAL; migration repair --status applied registra, no aplica SQL. Registrar únicamente la versión realmente confirmada/auditada y comprobar fila única. No repair masivo ni reejecutar 001–005. Si falla el registro, detenerse y reconciliar antes de continuar.
5. Auditar 001–008 registradas, objetos completos, índices válidos, triggers/constraints, ACL/RLS/propietarios, pos privado, ausencia de CREATE residual y comparación financiera sin diferencias. Los costos históricos permanecen NULL. Registrar y resolver cualquier cambio inesperado antes de desplegar.
6. Solicitar autorización para el Worker V1 compatible con esa base. Guardar su versión/despliegue anterior. El paquete se comprobó con --dry-run; comando REAL preparado, NO EJECUTADO:

```powershell
npx wrangler@4.152.0 deploy --config worker/api/wrangler.jsonc
```

7. Validar health, JWT ficticio→401, CORS y sesión real/perfil propio con el mismo JWT. Mantener los logs saneados; no imprimir tokens o cuerpos. Con identidad válida, comprobar consultas de catálogo, cartera/caja según rol y reportes. No generar ventas/abonos ficticios en producción. Si se necesita una transacción real de comprobación, requerirá autorización explícita y conservará su auditoría.
8. Antes de main, autorizar agregar VITE_API_URL=https://cai-market-api.brysof22.workers.dev **solo en Pages producción**, preservando URL/key originales y demás configuración. No hacen falta cambios de permisos o variables del servicio Supabase. La validación del build impedirá publicar si falta la API. No tocar Preview.
9. Revisar y versionar el diff de preparación en release con autorización del lote, comprobar árbol sin secretos/respaldos y repetir comprobaciones si cambia el código. Solicitar autorización de integración/push main: Pages está conectado a GitHub, por lo que **push a main inicia publicación de producción automáticamente**. No es una acción separada sin efectos remotos.

```powershell
git fetch origin
git switch main
git merge --ff-only origin/main
git merge --ff-only release/cai-market-v1
# Solo con autorización de integración y publicación:
git push origin main
```

Si --ff-only falla, detenerse y revisar la divergencia: no force push, reset ni sustitución de main. No usar wrangler pages deploy además del build Git para evitar dos publicaciones concurrentes.

10. Verificar Pages build correcto, CSP/CORS, sesión, navegación/permisos y datos reales. Volver a ejecutar npm run check:deployment (solo sondas públicas con JWT ficticio y sin escrituras) y comprobar con usuario autorizado las consultas. Fallos críticos mantienen el sistema en mantenimiento; no declarar producción lista únicamente por build/health.

## Recuperación y límites

Un fallo dentro de un archivo revierte su transacción, pero un COMMIT previo de 006 no se revierte automáticamente si 007 falla. Ante fallo posterior al COMMIT, usar una corrección revisada o la recuperación ensayada/autorizada, considerando escrituras posteriores. No borrar datos ni marcar versiones reverted para simular reversión.

Antes de publicar, conservar las versiones de Pages/Worker anteriores y preparar un rollback coordinado de código compatible; las migraciones aditivas se conservan salvo un plan SQL independiente revisado. No restaurar una copia vieja sobre operaciones posteriores sin evaluar pérdida de datos.

La contabilidad sigue siendo operativa, los pagos bancarios de confirmación manual y las devoluciones completas. No se añadieron facturación tributaria, conciliación bancaria, ventas offline ni credenciales administrativas en frontend.

## Verificaciones locales de esta preparación

API 82/82, integridad financiera 83/83 (incluye preflight/baseline y preservación de filas/saldos anteriores), TypeScript API/SQL y lint correctos. Build con CF_PAGES_BRANCH=main correcto; advertencia de chunk principal 505,12 kB. Empaquetado Wrangler --dry-run correcto, sin subir versión. Escáner de bundle sin marcadores demo/harness ni claves secretas de los patrones comprobados. La primera compilación detectó una extensión faltante en una importación nueva; se corrigió y repitió satisfactoriamente.

Interfaz completa: 41/41 pruebas correctas (6,8 minutos), sin omisiones; los flujos de comercio recorren UI → Worker → SQL/PGlite con Auth simulado. Revisión de 142 archivos versionables sin candidatos de credenciales reales/respaldos según los patrones comprobados; .env.local, la configuración temporal del harness y artefactos siguen ignorados. No se afirma una auditoría exhaustiva de secretos.

Estos resultados no sustituyen respaldo/restauración ni prueba publicada con JWT real. El estado global sigue **NO LISTO PARA PUBLICAR** mientras falte respaldo y autorización de las acciones remotas. GitHub sigue en main=27aa8c7 y release=385eb8a; las modificaciones de esta preparación solo existen en el árbol local.
