# CAI Market V1.4 — corrección del reinicio protegido

## Diagnóstico confirmado

El 27/10/2026 los registros de Supabase mostraron `SQLSTATE 21000` y el mensaje exacto `DELETE requires a WHERE clause`. El contexto identifica `pos.purge_operation(jsonb,uuid)`, línea 19, en `EXECUTE`, con `DELETE FROM pos.reminder_delivery_events`. La tabla estaba vacía, lo cual no evita que falle la validación de la sentencia. Los registros HTTP del gateway muestran respuestas 400 para `POST /rest/v1/rpc/cai_operations` durante los intentos investigados.

El rol `authenticator` tiene `session_preload_libraries=supautils, safeupdate`. La función V1.3 contenía eliminaciones sin `WHERE`, incompatibles con esa protección. La V1.4 conservó la función. Se comparó el cuerpo desplegado, normalizando únicamente finales de línea, con el archivo 011 del repositorio: coinciden. El historial instalado contiene 001–012. No se encontró una discrepancia de versión ni una clave foránea como causa del error observado.

Recorrido: `src/features/operations/reset.tsx` → `POST /api/operations` → `worker/api/src/catalog.ts` → `public.cai_operations` V1.4 → `pos.operations_v13` → `pos.purge_operation`. El Worker convertía el HTTP 400 de PostgREST en `422 INVALID_OPERATION`; el cliente mostraba su mensaje genérico de datos/existencias. No era evidencia de existencias inválidas.

## Corrección limitada

`supabase/migrations/20261027001300_reset_safeupdate.sql` reemplaza únicamente la función privada. Cada eliminación lleva un predicado explícito sobre una clave no anulable: `id`, `product_id` para existencias y `actor_id` para solicitudes idempotentes. También se califica la limpieza de confirmaciones temporales. Se comprobó que esas columnas son no anulables en todas las tablas incluidas. El conjunto de filas contemplado por el reinicio autorizado permanece igual, incluidos períodos anteriores.

No se desactiva ni reconfigura `safeupdate`. No se modifican migraciones aplicadas, claves foráneas, saldos, tablas ni usuarios. La migración define la función; nunca la invoca. El orden de dependencias se conserva: entregas/intentos/avisos, cierres/ajustes/devoluciones, movimientos/pagos/detalles, asignaciones/abonos/cargos/autorizaciones/cuentas, ventas/cajas, inventario, auditoría e idempotencia. Se mantienen las restricciones y su tratamiento transaccional existente.

La identidad reciente sigue limitada a cinco minutos; la confirmación temporal continúa ligada a usuario, sesión, período, vencimiento y huella de los datos. Se conserva rol administrador, frase `ELIMINAR OPERACION`, motivo, bloqueo exclusivo `NOWAIT`, control de envíos en curso y reintentos idempotentes. El vencimiento ahora tiene el código específico `RESET_INTENT_EXPIRED`, separado de una confirmación ajena, usada o inválida.

## Mensajes y diagnóstico seguro

`worker/api/src/catalog.ts` conserva códigos conocidos para vencimiento, datos modificados y concurrencia. Distingue identidad reciente de permisos insuficientes. Un error inesperado de SQL durante la confirmación devuelve `RESET_INTERNAL_ERROR`; un fallo de transporte sin resultado confirmado devuelve `RESET_RESULT_UNKNOWN`. Registra únicamente evento, HTTP de origen, SQLSTATE y código normalizado; no registra cuerpos, consultas, motivos, identidades, contraseñas ni tokens.

`src/lib/api-client.ts` presenta mensajes diferenciados y no muestra errores SQL arbitrarios. Ante un resultado desconocido no afirma que se haya completado o revertido el reinicio. No hay reintentos automáticos. El formulario y la clave pendiente se conservan al fallar para que un reintento manual de la misma solicitud mantenga la idempotencia.

## Pruebas y límites

- 205 pruebas API aprobadas, incluidas 11 nuevas de errores, privacidad y timeout. Cubren error real `21000`, claves foráneas `23503`, vencimiento, sesión inválida, frase/motivo, identidad reciente, permisos, concurrencia e internos.
- 23 pruebas SQL aprobadas: cinco nuevas y regresiones V1.3/V1.4. El escenario aislado reproduce siete ventas, cuatro cargos, saldo pendiente de $1.000, stock 313 y caja cerrada, usando exclusivamente datos sintéticos. El reinicio confirmado conserva catálogos/configuración y la siguiente numeración es V-1; repetir la misma solicitud devuelve el mismo resultado.
- Se inyectó un fallo en la auditoría final, después de las eliminaciones, cambio de período y reinicio de secuencia. La reversión conserva las huellas de todas las filas, período, intento y secuencia; retirar el fallo de prueba permite reintentar el mismo intento.
- Dos recorridos Playwright aprobados: éxito integrado navegador → Worker → SQL aislado, y error interno sin repetición automática, sin pérdida del formulario y con la misma clave al reintentar.
- `tests/credit/reset-concurrency.py`: PostgreSQL nativo, dos conexiones, directorio local verificado. Un bloqueo compartido independiente hace fallar la confirmación con `OPERATION_IN_PROGRESS`, antes del borrado, conservando las huellas de las filas.
- Prueba adicional del envoltorio de instalación: filas y configuración del rol permanecen idénticas. TypeScript, lint y compilación aprobados.

PGlite y el PostgreSQL nativo disponible no incluyen el binario `safeupdate`; no se afirma haber cargado esa extensión localmente. La incompatibilidad se confirma mediante los registros reales, la configuración del rol y el código oficial de la extensión. La compatibilidad de las nuevas sentencias se verifica mediante predicados explícitos y pruebas de ejecución/contratos en bases aisladas. No se reprodujo el borrado en producción.

## Archivos

- Función: `supabase/migrations/20261027001300_reset_safeupdate.sql`.
- Verificación de solo lectura: `supabase/checks/reset_safeupdate_integrity.sql`; puede complementarse con `v14_postmigration_integrity.sql`.
- Normalización y mensajes: `worker/api/src/catalog.ts`, `src/lib/api-client.ts`.
- Pruebas: `tests/credit/reset-fix-fixture.ts`, `tests/credit/reset-fix.spec.ts`, `tests/credit/reset-concurrency.py`, `tests/api/reset-fix.spec.ts`, `tests/reset-fix-ui.spec.ts`.
- El fixture `tests/fixtures/business.ts` utiliza la nueva migración para los recorridos integrados. El componente de reinicio y sus verificaciones de formulario no se modifican.

## Verificación segura

1. En el proyecto local, ejecutar `node --max-old-space-size=768 --wasm-num-compilation-tasks=1 --liftoff-only ./node_modules/@playwright/test/cli.js test -c playwright.credit.config.ts reset-fix.spec.ts`. Usa PGlite aislado, sin URL de producción.
2. Ejecutar las pruebas API con `node ./node_modules/@playwright/test/cli.js test -c playwright.api.config.ts reset-fix.spec.ts`.
3. Ejecutar los recorridos de navegador con `node --max-old-space-size=768 --wasm-num-compilation-tasks=1 --liftoff-only ./node_modules/@playwright/test/cli.js test reset-fix-ui.spec.ts v11-ui.spec.ts --grep 'fallo interno|reinicio exige' --workers=1`. La autenticación, base y almacenamiento de estos recorridos son ficticios y locales.
4. En producción, comprobar versión publicada, historial 013, cuerpo/propietario/permisos de la función y permanencia de `safeupdate` mediante consultas de solo lectura. No invocar `reset.confirm`. La instalación compara cantidades y huellas de las tablas comerciales y configuración del rol dentro de una sola transacción; cualquier discrepancia aborta.
5. El propietario puede revisar la vista previa desde la aplicación, sin pulsar la confirmación destructiva. La prueba completa de confirmación debe hacerse exclusivamente con los fixtures aislados. Este trabajo no solicita ni inicia un reinicio real.

## Fuentes técnicas

- [Implementación oficial de pg-safeupdate](https://github.com/eradman/pg-safeupdate/blob/master/safeupdate.c): comprueba la presencia de condiciones después del análisis de la consulta y antes del planificador.
- [Consulta oficial de registros Supabase](https://supabase.com/docs/guides/observability/advanced-log-filtering).

## Publicación

Migración 013 aplicada mediante una transacción que verificó que el cuerpo anterior coincidía con la versión investigada, todas las cantidades/huellas de filas permanecían iguales y la configuración de `authenticator` no cambiaba. Resultado: `RESET_FIX_INSTALLED_ROWS_AND_ROLE_CONFIG_UNCHANGED`. Auditoría posterior de solo lectura: `RESET_FIX_INTEGRITY_PASS`.

Worker publicado: `faf8a120-b0b0-4a43-9ccf-d4a8587b1073`. No se invocó `reset.confirm` en producción, no se modificaron saldos y no se generaron respaldos. El cambio sólo permite que una futura solicitud explícita y válida del propietario recorra la función corregida.
