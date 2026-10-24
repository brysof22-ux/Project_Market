# Entrega de arquitectura y migraciones de créditos

La [propuesta técnica](PROPUESTA.md) contiene el ER actualizado, decisiones de vencimiento, cupos, FIFO, arquitectura Worker/Supabase, API, modelo de acceso y plan de migraciones. Leerla antes de aplicar SQL.

La [validación local](VALIDACION.md) registra las comprobaciones realizadas y sus límites.

Actualización posterior: se añadió la migración independiente `20261023000500_current_profile_rpc.sql` para `/api/me`, sin editar las cuatro financieras. El fixture carga ahora las cinco migraciones y comprueba también la lectura del perfil propio. Ver [la API](../../worker/api/README.md) para permisos, validación y pasos pendientes de autorización; `pos` sigue fuera de Data API.

## Archivos generados

- `supabase/migrations/20261023000100_pos_credit_prerequisites.sql`: base mínima para una instalación nueva, sin datos comerciales ficticios.
- `supabase/migrations/20261023000200_credit_ledger.sql`: cartera, autorizaciones históricas, ventas/pagos mixtos, abonos FIFO, controles de integridad, consultas y auditoría.
- `supabase/migrations/20261023000300_credit_reminders.sql`: consentimiento/contacto, cola mensual, preflight, intentos y eventos de entrega deduplicados. **No contiene HTTP ni envía WhatsApp.**
- `supabase/migrations/20261023000400_credit_access.sql`: propiedad, RLS, roles técnicos y permisos mínimos.
- `worker/credit-reminders/dry-run.ts`: fábrica de handler programado y adaptador mock en memoria, sin credenciales ni llamadas de red. Requiere implementar el repositorio SQL para desplegar un Worker; no es un Worker ya conectado.
- `tests/credit/fixture.ts`, `tests/credit/credit-db.spec.ts`: base embebida aislada y pruebas financieras, de recordatorios y de permisos.
- `supabase/checks/credit_hosted_preflight.sql`: consultas de solo lectura preparadas para comprobar versión, administrador y roles del futuro proyecto de pruebas alojado. No ejecutadas en Supabase.
- `tests/credit/CONCURRENCIA.md`: escenarios reproducibles en conexiones PostgreSQL independientes; preparados, pendientes de un entorno de pruebas autorizado.
- `playwright.credit.config.ts`, `tsconfig.credit.json`: pruebas SQL y comprobación de tipos separadas del frontend.

Se actualizaron `package.json`/lock con PGlite como dependencia de desarrollo y scripts, el README principal y la exclusión de pruebas SQL en la configuración de Playwright visual. No se modificaron componentes, estilos, navegación ni datos simulados de React.

## Comandos disponibles ahora, sin Supabase ni mensajes

Desde `E:\Project_CAI_Market`:

```powershell
npm ci
npm run check:credit
npm run test:credit
npm run build
npm run lint
npm run test:e2e
```

`test:credit` carga las migraciones disponibles únicamente en PGlite en memoria y sustituye el reloj interno en el fixture. No usa `SUPABASE_URL`, una URL de producción, una cuenta Meta, un token real ni un navegador. El reloj de producción utiliza el servidor, no una fecha enviada por React. Auth y su helper `auth.uid()` se representan mediante fixtures locales.

El script limita la compilación paralela de WebAssembly y usa el compilador base de V8 solo para este proceso de pruebas. Esto reduce el pico de memoria; no cambia la configuración del frontend o del futuro Worker. La suite se detiene ante el primer fallo.

## Siguiente etapa: Supabase alojado, sin Docker

Las cuatro migraciones siguen siendo borradores para una instalación nueva. **No se aplicaron a Supabase.** Si algún entorno ya registró estas versiones, no volver a ejecutarlas ni editar su historial: preparar una migración incremental con inventario de constraints/datos y revalidación de vencimientos; no alterar ventas históricas de forma automática.

```powershell
# Solo para una futura revisión autorizada del proyecto de PRUEBAS alojado.
# CAI_TEST_DATABASE_URL debe provenir del gestor de secretos, nunca del repositorio.
psql "$env:CAI_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/checks/credit_hosted_preflight.sql
```

El script anterior solo consulta catálogos; no constituye una autorización ni una aplicación de migraciones. Revisar CREATEROLE, CREATE en la base, USAGE/REFERENCES sobre Auth y capacidad de SET ROLE al propietario. Las migraciones requieren roles administrados por Supabase (`authenticator`, `anon`, `authenticated`, `service_role`) y `auth.users`. Un PostgreSQL vacío necesita el bootstrap de pruebas.

Para esta revisión no hace falta iniciar sesión en Supabase, ejecutar `supabase link`, crear secretos, aplicar SQL remoto ni desplegar cron. Las migraciones no crean contraseñas ni identidades de empleados reales.

## Secuencia de integración posterior

1. Revisar la política definitiva ya incorporada: compras 1–28 vencen el 28 actual; compras posteriores, el 28 siguiente, incluidos cambios de año.
2. Tras autorización, validar preflight y migraciones en un proyecto Supabase alojado de pruebas, separado de producción; comprobar grants, RLS, Auth/PostgREST y concurrencia multi-conexión. No se necesita Docker.
3. Implementar Worker API con JWT verificado y RPC PostgREST que recibe el JWT original, importes exactos, errores mapeados y límites de tamaño. Rechazar `actor_id`/`p_actor` del body. Ver el modelo de confianza en `PROPUESTA.md` y `VALIDACION.md`. Los handlers HTTP no están implementados aún; una conexión SQL con `pos_app` y GUC de actor ya no es un mecanismo autorizado.
4. Conectar Crédito al POS y crear **Créditos y cuentas por cobrar** usando los contratos de la propuesta. El frontend actual sigue siendo simulado; esta entrega no afirma que el módulo visual o la autenticación ya estén operativos.
5. Implementar verificación de posesión de WhatsApp y el webhook HTTP con firma `X-Hub-Signature-256` sobre los bytes originales. La función SQL de entrega se invoca solo después de verificar la firma; no valida HTTP por sí sola.
6. Conectar el handler programado al repositorio, conservando `MockWhatsAppTransport`. Configuración futura de cron: preparación `0 14 28 * *`; atención de cola `*/5 * * * *`. SQL vuelve a comprobar el día 28 y la ventana 09:00–18:00 de Bogotá. El Worker debe limitar duración/lotes y consultar nuevamente al preparar cada envío.
7. Diseñar reconciliación de estados `dispatching` abandonados y `unknown` sin reenviarlos automáticamente. No marcar un mensaje como entregado solo por recibir aceptación HTTP.
8. Antes de considerar transporte real: comprobar elegibilidad con Meta/BSP, consentimiento, plantilla aprobada, versión Graph API y credenciales en Cloudflare Secrets. Adaptador y habilitación real requieren otra revisión. En esta etapa tanto constraints de proveedor como las funciones permiten únicamente `mock`.

No hay comandos de despliegue o de envío real: no son necesarios para revisar estos archivos.

## Límites de validación

PGlite ejecuta PostgreSQL real compilado a WebAssembly y sirve para validar SQL, funciones, triggers y grants. No reproduce el stack Auth/PostgREST de Supabase ni conexiones concurrentes independientes. Las pruebas multi-conexión, el Worker desplegado, el webhook firmado y los recorridos visuales del futuro módulo de cartera requieren verificaciones posteriores.

La unicidad mensual y las reservas evitan dos despachos lógicos. No se promete una transacción exactamente una vez entre PostgreSQL y un proveedor HTTP. Después del último preflight puede existir un pago concurrente con el envío ya iniciado; el mensaje lleva fecha de corte y no se reintentan resultados inciertos.
