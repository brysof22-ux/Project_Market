# Revisión de créditos y seguridad — 23 de octubre de 2026

Las cuatro migraciones son borradores para una base nueva; se actualizaron en el repositorio y se ejecutaron únicamente en PGlite aislado. No se conectó a Supabase, no se ejecutaron migraciones remotas ni Docker y no se enviaron mensajes. No se modificaron componentes ni estilos del frontend.

## Problemas encontrados y correcciones

| Problema | Corrección |
| --- | --- |
| La función rechazaba compras posteriores al 28 y el CHECK exigía el mismo mes | Función única antes de crear la tabla; compras 1–28 vencen el 28 actual, posteriores el 28 siguiente. CHECK con nombre exige exactamente esa función, además de vencimiento no anterior a compra. Se eliminó el bloqueo pendiente. |
| p_actor se aceptaba sin identidad autenticada | Todas las operaciones de personal pasan por require_staff: sesión del gateway authenticator, JWT de rol authenticated vigente, sujeto igual a p_actor y perfil activo en PostgreSQL. Cambiar el actor a otro administrador activo se rechaza antes de efectos financieros. |
| Un usuario SQL podía fabricar claims con SET/set_config | El contexto exige session_user authenticator, que no cambia con SECURITY DEFINER ni SET ROLE. Una conexión pos_app con claims falsificados se rechaza. No se usa una contraseña SQL compartida para identificar cajeros. |
| La transferencia de propiedad y RLS dependía de privilegios implícitos | Se habilita RLS antes de transferir tablas. Se concede CREATE temporal al propietario sobre el esquema y se revoca después. Para gestionar permisos se usa SET LOCAL ROLE pos_owner explícito. El esquema queda bajo el administrador de migraciones, evitando exigir CREATE de base al rol propietario de objetos. |
| Los roles existentes podían traer privilegios de otro sistema | Se rechazan LOGIN, superusuario, CREATEROLE, CREATEDB, replicación, BYPASSRLS, membresías salientes y miembros distintos del administrador actual. No se eliminan privilegios de roles ajenos silenciosamente. |
| PostgreSQL 16+ separa SET de ADMIN en membresías | Rama dinámica concede SET TRUE e INHERIT FALSE al administrador para pos_owner. PG15 conserva GRANT estándar; esa rama PG15 no se ejecutó en esta validación. |
| Un snapshot repetible podría leer cartera antigua después de esperar un bloqueo | Personal, claim y preflight exigen READ COMMITTED y releen saldos bajo bloqueo de cuenta. Se agregó prueba de rechazo de REPEATABLE READ. |
| El esquema aceptaba proveedor meta aunque el transporte era ficticio | Constraints y registro de eventos admiten únicamente mock. El adaptador continúa sin HTTP ni credenciales. Habilitar transporte real requerirá otro cambio revisado. |

La compra utiliza el reloj interno del servidor convertido a America/Bogota. Ejemplos verificados mediante ventas y consultas SQL: 05/10 → 28/10; 28/10 → 28/10; 29, 30 y 31/10 → 28/11; 31/12/2026 → 28/01/2027; 29/02/2028 → 28/03/2028. También se verifica el cambio a las 05:00 UTC, medianoche en Bogotá.

## Modelo de confianza para la integración futura

1. React envía el JWT de acceso y los datos comerciales al Worker. El rol visible en la interfaz y user_metadata no conceden permisos.
2. El Worker valida la autenticidad del JWT con Supabase Auth mediante getClaims/JWKS o getUser del servidor; comprueba proyecto/emisor, audiencia authenticated, sujeto y expiración. Rechaza p_actor/actor_id enviados por el cliente.
3. El Worker llama RPC de Supabase PostgREST con el JWT ORIGINAL en Authorization, la clave pública del proyecto en apikey y Content-Profile: pos para POST. p_actor se toma del sujeto verificado. No se sustituye por service_role, no se firma un token inventado ni se convierte a GUC sobre una conexión SQL compartida.
4. PostgREST verifica la firma y establece la sesión authenticator, el rol authenticated y request.jwt.claims. SQL vuelve a comprobar sujeto, expiración y perfil activo. La autenticidad de la firma pertenece al gateway; el SQL no pretende verificar criptografía leyendo JSON.
5. authenticated recibe USAGE del esquema y EXECUTE de nueve funciones de personal, sin permisos de tablas, vistas, helpers ni tareas programadas. Es necesario configurar pos como esquema expuesto en la futura Data API. Las llamadas directas a la API conservan los mismos controles; no dependen de atravesar el Worker para autorizarse.
6. La contraseña de authenticator queda exclusivamente bajo control de Supabase. No otorgar membresía en ese rol ni en pos_owner a credenciales de aplicación. El administrador de base es una identidad de confianza capaz de cambiar el esquema; estas defensas no pretenden impedir acciones de un administrador comprometido.
7. El programador futuro tendrá una credencial separada limitada a pos_scheduler. No puede autorizar cupos, vender, registrar abonos ni verificar teléfonos. Nunca exponer RPC que cambie claims, ejecute SQL arbitrario o permita modificar perfiles desde el navegador.

Los handlers HTTP, verificación real de JWT y repositorio del Worker financiero siguen pendientes; se actualizó su contrato, no se afirma que estén conectados. pos_app permanece NOLOGIN como rol reservado, con funciones acotadas pero sin autorización para movimientos financieros mediante una sesión SQL directa.

## Compatibilidad con Supabase alojado

Supabase documenta que postgres no es un superusuario pleno; no se asume acceso a supabase_admin. Se necesita un administrador con CREATEROLE, CREATE en la base para crear el esquema, USAGE sobre auth, REFERENCES sobre auth.users y capacidad de SET al rol propietario. Las tablas, vistas y funciones quedan bajo pos_owner NOLOGIN, sin BYPASSRLS ni privilegios administrativos. El esquema pertenece al administrador. RLS habilitado sin permisos de tablas para clientes; el propietario ejecuta las funciones con validaciones explícitas.

Las cuatro migraciones se cargaron correctamente usando credit_migrator CREATEROLE NOSUPERUSER en la prueba. Esto valida las operaciones PostgreSQL empleadas, pero no reproduce restricciones adicionales del servicio alojado, sus event triggers, versión específica, configuración de PostgREST ni permisos particulares del proyecto.

Se preparó supabase/checks/credit_hosted_preflight.sql, de solo lectura, para revisar el proyecto de PRUEBAS tras autorización. No se ejecutó. Las credenciales, roles existentes, nombre real de sesión del gateway, esquema expuesto y grants deben comprobarse allí antes de aplicar.

SECURITY DEFINER conserva propietario sin login, rutas fijas pg_catalog, pos, pg_temp y referencias cualificadas. Las funciones internas no tienen EXECUTE público. No hay SQL dinámico controlado por usuarios; el SQL dinámico de migración solo recorre objetos del esquema. El propietario solo recibe CREATE de esquema durante la transferencia. Nuevas funciones deberán crearse con el propietario previsto y revocar EXECUTE público antes del commit; los defaults de pos_owner lo refuerzan.

## Integridad, concurrencia y separación financiera

Se conservan autorizaciones de cupo inmutables, responsable y fecha, deuda acumulada, disponibilidad, abonos parciales/completos, FIFO y auditoría. El cliente no modifica saldos directamente. Hay FKs compuestas para impedir asignaciones entre cuentas, validaciones de importes, claves de idempotencia persistentes, triggers diferidos de sumas y registros financieros inmutables.

Las operaciones bloquean cuenta → sesión de caja → productos/saldos ordenados. Idempotencia utiliza bloqueo asesor antes de la operación. El débito de stock, venta, pagos y cartera se confirman en una transacción. No se cambió el cálculo de ingresos: efectivo recibido genera cash_entries; transferencias son recaudo sin efectivo físico; el principal financiado queda como cuenta por cobrar.

Un cliente solo tiene una cuenta y un recordatorio por cuenta/mes. Se agregan todos los saldos pendientes, incluso compras de distintos meses; claim y preflight recalculan deuda y consentimiento. Sin deuda no se encola o se cancela el despacho reservado. Los reintentos son limitados y un resultado ambiguo no se reenvía automáticamente. No existe garantía de entrega externa exactamente una vez ni transporte real en esta etapa.

Los escenarios multi-conexión están en tests/credit/CONCURRENCIA.md: cupo disputado con productos iguales/diferentes, sobreabono concurrente, idempotencia, cambio de cupo, doble reserva, pago frente a preflight y cierre de caja. Se prepararon, pero NO se ejecutaron con conexiones PostgreSQL independientes. PGlite serializa las consultas y no demuestra concurrencia real.

## Pruebas ejecutadas

| Comprobación | Resultado |
| --- | --- |
| Cuatro migraciones en PGlite con administrador sin superusuario | Correcta |
| Playwright SQL y handler mock | 52 aprobadas |
| Playwright visual Chromium, un worker | 21 aprobadas: 8 de aplicación y 13 de transferencias |
| npm run check:credit | Correcto |
| npm run build | Correcto |
| npm run lint | Correcto |
| Supabase Auth/PostgREST real, migraciones remotas, concurrencia multi-conexión | No ejecutados |
| WhatsApp real | Sin transporte, credenciales ni envíos |

La suite incluye días 28/29/30/31, cambios de mes/año, febrero bisiesto, constraint de vencimiento, fecha inválida, medianoche en Bogotá, ventas financiadas, pagos mixtos, historial/cupos, FIFO, sobrepagos, liquidación, idempotencia, nueve intentos de suplantación de un administrador activo, claims incompletos/vencidos, contexto SQL falsificado, RLS/propiedad/EXECUTE, aislamiento, recordatorios acumulados de distintos meses, falta de deuda/consentimiento, pago antes del preflight y reintentos.

La regresión visual cubre navegación, inventario, POS, contabilidad, temas, móvil/tableta, QR fijo automático y ampliable, cambio de QR, PNG/JPG/WebP, importe exacto, referencia, confirmación manual, cancelación, roles demo, pago mixto y prevención de doble registro local. Son operaciones de demostración; no validan bancos ni permisos reales de Supabase.

## Archivos y siguientes pasos

Modificados: las cuatro migraciones SQL; tests/credit/fixture.ts y credit-db.spec.ts; tests/credit/CONCURRENCIA.md; docs/creditos/PROPUESTA.md, README.md y este informe. Nuevo: supabase/checks/credit_hosted_preflight.sql. No se modificó src ni el Worker de simulación. La compilación regeneró dist y Playwright generó sus artefactos de pruebas.

Comandos ejecutables ahora, sin servicios externos:

```powershell
npm run check:credit
npm run test:credit
npm run build
npm run lint
npm run test:e2e -- --workers=1 --max-failures=1
```

Antes de una aplicación autorizada: revisar preflight y roles del proyecto alojado de pruebas, aplicar el conjunto completo allí, verificar JWT/RPC reales y concurrencia; después implementar y conectar el Worker y la vista de créditos. No se requiere Docker. Si alguna versión de estas migraciones ya fue aplicada en otro entorno, preparar una migración incremental en vez de reejecutar o reescribir su historial; no recalcular datos históricos sin revisión.

## Fuentes primarias consultadas

- [Supabase: postgres y límites de superusuario](https://supabase.com/docs/guides/database/postgres/roles-superuser).
- [PostgreSQL: atributos de roles y membresía desde PostgreSQL 16](https://www.postgresql.org/docs/17/role-attributes.html).
- [PostgreSQL: requisitos de transferencia de propiedad](https://www.postgresql.org/docs/current/sql-altertable.html).
- [PostgREST: verificación JWT y cambio de rol de sesión](https://docs.postgrest.org/en/stable/references/auth.html).
- [Supabase: permisos de Data API y funciones](https://supabase.com/docs/guides/api/securing-your-api).
- [Supabase Auth: getClaims y verificación](https://supabase.com/docs/reference/javascript/auth-getclaims).
