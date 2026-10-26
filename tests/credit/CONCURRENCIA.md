# Escenarios multi-conexión preparados para un entorno aislado

Actualización 25/10/2026: se ejecutaron y aprobaron 12 escenarios sobre PostgreSQL 17.11 real aislado, con dos conexiones y bloqueos comprobados para ventas, abonos, devoluciones y cierres de caja. Resultados, alcance y evidencias en [ENSAYO_006_008_20261025.md](../../docs/integracion/ENSAYO_006_008_20261025.md). Los escenarios de recordatorios y HTTP con JWT reales de este documento no se presentan como ejecutados por ese ensayo. El texto siguiente conserva las propuestas históricas previas a esa ejecución.

No ejecutados: falta un proyecto alojado de pruebas autorizado. Esta etapa no utiliza Docker. Las pruebas PGlite no se presentan como evidencia de concurrencia real.

Después de autorizar y aplicar las migraciones en un proyecto Supabase alojado de PRUEBAS, usar dos conexiones psql y datos ficticios. Crear identidades de prueba con Auth y perfiles activos; abrir caja y registrar producto de precio 100 y stock 10. No usar producción. Las conexiones financieras normales pasan por PostgREST con JWT original; para mantener bloqueos en psql, estos ejemplos requieren un administrador controlado capaz de `SET SESSION AUTHORIZATION authenticator`. No otorgar ese privilegio al Worker ni a un empleado. Si el administrador alojado no puede hacerlo, usar un PostgreSQL independiente desechable con ese bootstrap, o dos peticiones RPC simultáneas con JWT reales para probar contención sin pausas artificiales.

En CADA transacción de prueba financiera, antes del SELECT (para operaciones sueltas envolver también en BEGIN/COMMIT):

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
-- Solo el arnés administrativo de pruebas emula el contexto del gateway.
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', jsonb_build_object(
  'sub', :'actor', 'role', 'authenticated',
  'exp', extract(epoch FROM clock_timestamp() + interval '1 hour'))::text, true);
-- SELECT de la operación, pausa opcional y COMMIT del escenario.
```

Esta emulación no verifica firmas JWT; probar además con PostgREST real que un token alterado/vencido falla y que cambiar p_actor devuelve 403. Las consultas de auditoría/saldos se ejecutan en otra sesión administrativa, nunca concediendo SELECT a authenticated. Las variables psql contienen UUID del fixture:

```sql
\set actor 'UUID_DEL_CAJERO_LOCAL'
\set customer 'UUID_DEL_CLIENTE_LOCAL'
\set session 'UUID_DE_LA_CAJA_LOCAL'
\set product 'UUID_DEL_PRODUCTO_LOCAL'
\set method 'UUID_DEL_METODO_EFECTIVO_LOCAL'
```

Autorizar cupo 100 antes del primer escenario:

```sql
SELECT pos.authorize_credit_limit(:'actor', :'customer', 100, 'Prueba local concurrente', 'setup-limit');
```

## 1. Dos ventas disputan el último cupo

Terminal A:

```sql
BEGIN;
SELECT pos.confirm_sale(:'actor', :'customer', :'session',
  jsonb_build_array(jsonb_build_object('product_id', :'product', 'quantity', 1)),
  '[]'::jsonb, true, 'concurrent-sale-A');
SELECT pg_sleep(10); -- mantener bloqueo de cuenta solo en esta prueba
COMMIT;
```

Mientras A espera, terminal B:

```sql
SELECT pos.confirm_sale(:'actor', :'customer', :'session',
  jsonb_build_array(jsonb_build_object('product_id', :'product', 'quantity', 1)),
  '[]'::jsonb, true, 'concurrent-sale-B');
```

Resultado esperado: B espera el bloqueo y, tras el commit de A, falla con `CREDIT_LIMIT_EXCEEDED`. Solo una venta, una obligación por 100 y un descuento de stock. Repetir con productos diferentes para demostrar que el bloqueo de cuenta protege el cupo independientemente del inventario. Las compras posteriores al 28 están permitidas y vencen el 28 siguiente.

## 2. Dos abonos no pueden cobrar más que la deuda

Con deuda 100, ejecutar desde A dentro de `BEGIN` un `record_credit_receipt` por 80, mantener `pg_sleep(10)` y confirmar. Desde B solicitar otro abono de 80 con otra clave. B debe esperar y luego fallar `AMOUNT_EXCEEDS_DEBT`. Queda saldo 20 y una entrada de efectivo por 80, nunca saldo negativo.

```sql
SELECT pos.record_credit_receipt(:'actor', :'customer', :'session', 80, :'method', NULL, 'concurrent-receipt-A');
-- B: misma llamada con clave 'concurrent-receipt-B'.
```

## 3. Doble envío del mismo abono/venta

Repetir el escenario anterior con **la misma clave y mismo payload** en ambas conexiones. B debe esperar y devolver el mismo `receipt_id` de A, sin una segunda distribución ni entrada de caja. Una carga diferente con esa clave debe fallar `IDEMPOTENCY_CONFLICT`. Repetir para `confirm_sale` y comprobar stock.

## 4. Cambio de cupo durante una venta

En A confirmar una venta de 100 con la cuenta bloqueada. En B intentar autorizar cupo 50. Después de confirmar A, B debe fallar `LIMIT_BELOW_DEBT`; el último cupo válido permanece y no se inserta una autorización fallida. Repetir invirtiendo el orden: si B baja a 50 primero, la venta de 100 falla.

## 5. Dos Workers toman el mismo recordatorio

Con contacto verificado, consentimiento vigente y deuda, ejecutar `enqueue_credit_reminders` para el 28. En A: `BEGIN; SELECT pos.claim_credit_reminder('2026-10-28 14:00Z'); SELECT pg_sleep(10); COMMIT;`. En B llamar la misma función mientras A espera. Debe devolver NULL o tomar otra cuenta, nunca el mismo recordatorio. Un nuevo intento después del commit tampoco puede tomar el ya `dispatching`.

## 6. Abono frente a preflight

Reservar un recordatorio. En A registrar el pago total manteniendo la transacción abierta. En B ejecutar `preflight_credit_reminder` con su token; debe esperar y devolver `skipped/no_debt` al confirmar A. Si el preflight confirma primero, el caso pasa a la ventana de mensaje en tránsito documentada; no se afirma que se pueda cancelar una entrega externa ya iniciada.

## 7. Cierre de caja frente a abono

La futura función de cierre debe bloquear `cash_sessions` con `FOR UPDATE`, igual que `lock_cash_session`. En A tomar ese bloqueo y cerrar la sesión; B registra un abono y espera. Tras A, B falla `CASH_SESSION_NOT_OPEN` sin cartera o efectivo parcial. El cierre completo pertenece al backend general, todavía no implementado; esta comprobación será de integración al añadirlo.

Registrar resultados, excepciones y consultas de saldos/caja después de cada escenario. Usar nuevas claves y datos aislados entre casos. No ejecutar aún contra Supabase; una futura ejecución requiere confirmar el identificador del proyecto de PRUEBAS y disponer de autorización para aplicar sus migraciones. Nunca usar producción.

## 8. Suplantación y aislamiento

Con JWT real del cajero A y p_actor del empleado B, las nueve RPC de personal deben fallar sin insertar auditoría ni movimientos. Repetir con token alterado, vencido, sin JWT, usuario sin perfil y perfil inactivo. Desde una conexión técnica SQL con claims fabricados debe fallar `UNTRUSTED_AUTH_CONTEXT`. La cuenta técnica no debe poder usar SET ROLE pos_owner ni crear funciones en pos. Un flujo financiero con REPEATABLE READ debe fallar `READ_COMMITTED_REQUIRED`.
