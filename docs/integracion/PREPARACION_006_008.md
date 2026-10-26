# Revisión de aplicación de 006–008 — 24/10/2026

**Estado vigente al 25/10/2026, 19:14 Colombia:** 006–008 ya aplicadas y registradas en Supabase original; auditoría aprobada y permisos originales restaurados. Ver [informe definitivo](RESULTADO_PRODUCCION_006_008_20261025.md). Las condiciones pendientes descritas debajo son históricas, no instrucciones para repetir migraciones.

Actualización 25/10/2026: respaldo restaurado verificado y ensayo sobre copias PostgreSQL reales completados. Ver [ENSAYO_006_008_20261025.md](ENSAYO_006_008_20261025.md), con comparación de datos, historial individual y 12 escenarios concurrentes aprobados. Las carencias enumeradas abajo describen la revisión histórica del día 24; no sustituyen el resultado actualizado. La aplicación en producción sigue pendiente de verificación vigente y autorización explícita.

Actualización de destino: ver [PRODUCCION_V1.md](PRODUCCION_V1.md). El usuario solicita producción sobre el proyecto original, sin Preview. La verificación de recuperación se hará localmente; no se creará otro proyecto alojado. Sigue siendo obligatorio disponer de respaldo restaurado, verificar las dependencias/saldos y obtener autorización antes de aplicar. El operador confirmó que aún no existe respaldo.

## Dictamen

Revisión local favorable y aplicación en producción **condicionada**, todavía no habilitada. No se identificó un defecto SQL bloqueante reproducible en los tres archivos actuales. No se modificaron las migraciones. Faltan evidencias remotas de privilegios, ausencia completa de objetos parciales, respaldo restaurado y ensayo sobre PostgreSQL alojado con conexiones independientes. No ejecutar los pasos de aplicación de esta guía hasta recibir autorización.

Estado remoto comunicado por el operador: 001–005 registradas; 006–008 sin registrar; las tres RPC y las seis tablas nuevas ausentes; pos_owner sin CREATE en pos/public. Esta revisión no hizo conexiones remotas. No reejecutar 001–005.

Archivos revisados, SHA-256 (si cambian, repetir la revisión del lote):

```text
006 9009E00E84822B795FEC8D6C9A5AC60F6C40042D61287B2271343FC2606E4237
007 D11B144C9C009EA6AE528E76A9AEC5B6828DECBC2119A83B34CB6A8C92704B8F
008 FA463CCF22DB5ED6E66A5290053A24F854181E27BF362A751F26D7104B36F08B
```

## Dependencias y efectos

| Archivo | Dependencias | Efectos al aplicar |
| --- | --- | --- |
| 20261023000600_catalog.sql | Base 001–004: tablas, roles, RLS, require_staff, begin_request, require_amount, business_now, prevent_financial_mutation; puente privado de 005 | Dos tablas, ampliación de productos/clientes, tres índices, trigger inmutable y cai_catalog. |
| 20261023000700_operations.sql | 006 y funciones financieras de 002; puente de 005; tablas/propietarios de 004 | Cuatro tablas, cuatro columnas, índices, triggers, cai_operations y sustitución de credit_charge_balances. |
| 20261023000800_reports.sql | Puente de 005; columnas de 006 y tablas/snapshots/vista de 007; saldos y libros de 001–004 | cai_report; no carga datos ni calcula saldos persistidos durante la migración. |

Orden obligatorio: 006 → validar → registrar → 007 → validar → registrar → 008 → validar → registrar. Usar un solo operador de migración. Los tres archivos contienen BEGIN/COMMIT y no registran por sí mismos schema_migrations.

No hay DROP, TRUNCATE, DELETE, backfill de movimientos ni cambios de propietario de tablas existentes. Los UPDATE/INSERT/ON CONFLICT que aparecen en los cuerpos se ejecutan al invocar posteriormente las RPC, no al definirlas. Las columnas nuevas aportan valores iniciales: categoría «Sin categoría», mínimo 0, versiones 1, contactos vacíos y permisos de cajero false. Costos y snapshots históricos quedan NULL: no se inventa ni recalcula el costo de ventas antiguas. Los permisos nuevos pueden impedir a cajeros existentes registrar créditos/gastos hasta una autorización explícita posterior; no se habilitan automáticamente.

007 sí reemplaza una definición existente: pos.credit_charge_balances. Conserva columnas/tipos del modelo local y descuenta credit_reduction de devoluciones. CREATE OR REPLACE conserva propietario y permisos de la vista, pero cambia su cálculo y afecta indirectamente a credit_account_balances, abonos e informes anteriores. Comparar su definición, columnas, ACL y resultados remotos con 002/004 antes de continuar. No aceptar una definición divergente solo porque las versiones figuran en historial. [Reglas PostgreSQL de CREATE OR REPLACE VIEW](https://www.postgresql.org/docs/current/sql-createview.html).

## Permisos, propietarios y SECURITY DEFINER

Las tres migraciones prestan temporalmente CREATE en los esquemas necesarios a pos_owner, crean objetos bajo SET LOCAL ROLE pos_owner, recuperan el rol migrador y revocan CREATE antes del COMMIT. Los préstamos y su revocación son transaccionales. 008 solo presta CREATE en public. No se modifican ACL de auth ni se requiere superusuario.

El operador debe acreditar, antes de aplicar:

- USAGE y capacidad de conceder CREATE en pos/public (propiedad o CREATE WITH GRANT OPTION). Tener CREATE sin GRANT OPTION no basta. Un WARNING de «no privileges were granted» no constituye éxito.
- Capacidad efectiva de SET ROLE pos_owner; en PostgreSQL 16+ comprobar también SET OPTION, no solo pertenencia. La membresía de 001 puede explicar este acceso, pero debe verificarse en el estado actual.
- pos_owner debe conservar propiedad de las tablas/vistas financieras y USAGE sobre pos/public; sin LOGIN, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB ni membresías peligrosas. No concederlo a anon/authenticated/roles de aplicación.
- pos.current_profile_auth_uid() debe ser el puente revisado de 005, SECURITY DEFINER propiedad del migrador confiable, con EXECUTE para pos_owner; sin EXECUTE público o de roles de aplicación. No transferir este puente a pos_owner para resolver un error.
- Inventariar pg_default_acl para pos_owner: grants a roles adicionales pueden heredarse al crear objetos. Revisar ACL efectivas y membresías, no solo grants explícitos.

Las RPC cai_catalog(text,jsonb,text), cai_operations(text,jsonb,text) y cai_report(jsonb) son SECURITY DEFINER, propiedad de pos_owner, con search_path fijo pg_catalog,pos,pg_temp. La identidad se obtiene del puente; require_staff exige gateway authenticator, claims authenticated coherentes/no vencidos, perfil activo bloqueado FOR SHARE e aislamiento READ COMMITTED. Los roles de negocio se consultan en la base, no se aceptan de React.

Se revoca EXECUTE a PUBLIC, anon, authenticated, service_role, pos_app y pos_scheduler y se concede solo a authenticated en cada RPC. Propietario/administradores mantienen sus derechos inherentes. capture_sale_cost() es SECURITY INVOKER y trigger, con EXECUTE revocado a los roles de aplicación. Las tablas nuevas tienen RLS activado y ACL revocadas a los mismos roles; pos_owner actúa como propietario a través de las RPC. Esa excepción a RLS es deliberada y hace crítica la autorización de cada función. El esquema pos debe seguir fuera de Data API; no se necesitan service_role ni cambios en el frontend.

004 conserva EXECUTE de algunas funciones financieras privadas para authenticated. No se amplía aquí. Su seguridad depende también de que pos continúe fuera de los esquemas expuestos y de que ninguna otra RPC permita SQL arbitrario o eludir los wrappers. La exposición Data API no se certifica mediante catálogos SQL solamente.

## Restricciones, índices y operación financiera

- 006: PK y FK a productos/proveedores/perfiles, barcode UNIQUE, costo no negativo, mínimo no negativo, cantidades delta no nulas/cero y razón acotada. El stock se modifica atómicamente con bloqueo y rango no negativo. Ediciones usan versionado optimista; comandos usan clave idempotente y auditoría.
- 007: sale_id y charge_id únicos en devoluciones; FK a venta/cargo/caja/método/perfil. CHECK refund_amount + credit_reduction = total y método obligatorio si hay reintegro. Ajustes de efectivo con signos/tipos coherentes, return_id único; un cierre por sesión y diferencia = contado − esperado. store_settings admite una fila id=true.
- Ventas/abonos reutilizan funciones financieras previas: precio servidor, inventario, distribución FIFO, cupo, caja e invariantes diferidas. No se borra venta/pago/cargo/abono original al devolver: se registra compensación, se cancela solo deuda restante y se reintegra lo efectivamente pagado.
- Bloqueos previstos: cuenta → sesión → venta cuando corresponde → productos/balances ordenados. El cierre y los ajustes bloquean la sesión; abrir caja usa las restricciones únicas existentes. Estos mecanismos necesitan validación de concurrencia en PostgreSQL real.
- Las restricciones locales no demuestran por sí solas toda la consistencia entre devolución, crédito e inventario; parte se garantiza mediante la RPC y la denegación de escrituras directas. No ejecutar DML administrativo que omita esas reglas.
- Hay índices por producto/proveedor/categoría, fechas, sesión/operador/actor y claves únicas de negocio. No toda FK necesita un índice para ser válida; revisar planes/volumen en staging. Los CREATE INDEX normales y ALTER TABLE toman bloqueos: aplicar en mantenimiento con límites de espera, no convertirlos improvisadamente en CONCURRENTLY dentro de estos archivos transaccionales.

## Objetos adicionales que deben estar ausentes antes de 006–008

Además de las tres RPC y las seis tablas que ya se consultaron, comprobar cualquier sobrecarga de las RPC y estos objetos:

| Versión | Objetos o cambios a descartar |
| --- | --- |
| 006 | customers.email/phone/version; products.category/barcode/purchase_price/minimum/supplier_id/version; índices inventory_adjustments_product_idx, products_category_idx, products_supplier_idx; trigger inventory_adjustments.immutable_record; UNIQUE de barcode, FK/checks/PK de las tablas nuevas. |
| 007 | profiles.can_credit/can_expenses; sale_items.purchase_price_snapshot/category_snapshot; función pos.capture_sale_cost(); trigger sale_items.sale_cost_snapshot; triggers immutable_record de sale_returns/cash_adjustments/cash_closings. |
| 007 | Índices sale_returns_date_idx, cash_adjustments_session_idx, cash_adjustments_date_idx, sales_actor_date_idx, cash_sessions_operator_date_idx, audit_events_date_idx; PK/UNIQUE/FK/CHECK de sus tablas nuevas. |
| 007 | Cambio de definición/dependencias de credit_charge_balances para incluir sale_returns/credit_reduction: la vista ya existe desde 002; su mera existencia no indica aplicación parcial. |
| Todas | CREATE residual, ACL/default ACL inesperadas, nombres de relación ocupados por otro tipo de objeto, columnas de definición distinta, funciones previas con firma alternativa. |

Examinar pg_class/pg_namespace, pg_attribute/pg_attrdef, pg_constraint, pg_index (indisvalid/indisready), pg_trigger (habilitación y función destino), pg_proc, pg_rewrite/pg_depend y pg_default_acl. Comparar con los archivos completos; no basta un to_regprocedure por versión. No usar IF NOT EXISTS, DROP ni repair para tapar un conflicto.

## Respaldo recuperable: condición previa obligatoria

1. Confirmar proyecto/ref, versión PostgreSQL, herramienta/versiones, responsable y destino de restauración autorizado. Programar ventana y detener todas las escrituras comerciales, integraciones, jobs, cambios de esquema y aprovisionamiento de usuarios durante la captura y validación. No crear servicios de pago ni activar PITR sin autorización.
2. Si existe backup administrado/PITR, documentar punto recuperable anterior al cambio, hora, cobertura y procedimiento. Un backup diario viejo puede perder operaciones posteriores; no basta que aparezca «backup disponible». Mantener además una copia lógica externa reciente cuando sea posible.
3. Exportar roles personalizados, esquema, datos/secuencias e historial. Deben incluir pos completo, wrappers public, perfiles y sus dependencias auth.users, identidades necesarias, membresías/propietarios/ACL/RLS, funciones, vistas, índices y triggers. Una copia solo de pos o solo del esquema no es suficiente. Verificar cobertura efectiva del CLI utilizado: auth/storage tienen tratamiento especial.
4. Con conexión segura obtenida fuera del repositorio, el procedimiento oficial separa roles.sql, schema.sql y data.sql (--data-only --use-copy). Exportar además history_schema.sql e history_data.sql con --schema supabase_migrations. No imprimir contraseñas/URL de conexión ni guardar los respaldos en Git. Son archivos con datos personales, requieren cifrado y acceso restringido. [Procedimiento oficial Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
5. Comprobar código de salida de cada exportación, advertencias, tamaños, cobertura y SHA-256; registrar fecha/hora/ref y versiones de 001–005, hash de los tres archivos por aplicar y una línea base privada de filas, importes, saldos, existencias y secuencias. Copiar el respaldo a almacenamiento independiente. El hash prueba integridad del archivo, no restaurabilidad.
6. Restaurar realmente en un destino Supabase compatible aislado y autorizado, nunca sobre producción. Seguir el procedimiento de restauración de esa versión y revisar conflictos de roles/esquemas administrados sin borrar objetos a ciegas. No considerar válido un ensayo que ignora errores de propietario, ACL o triggers. Verificar funciones/privilegios, UUID de usuarios/perfiles, PK/FK/CHECK, RLS, triggers habilitados y secuencias, historial y reconciliación contra la línea base. Probar acceso y operación en ese destino sin enviar notificaciones externas.
7. El respaldo se acepta únicamente cuando se ha restaurado y validado, y están documentados tiempo de recuperación, punto de pérdida aceptable y credenciales/configuración externas necesarias. Repetir captura si hay nuevas escrituras relevantes después de la copia.

Los backups de base de datos no incluyen los archivos físicos de Supabase Storage. Cloudflare R2, variables, secretos y configuración de Auth/Data API/CORS tampoco quedan garantizados por un dump SQL: inventariarlos y respaldarlos por separado según uso. No se presupone qué plan o backup tiene este proyecto. [Cobertura de backups Supabase](https://supabase.com/docs/guides/platform/backups).

## Aplicación futura, solo tras autorización

Ensayar primero los archivos exactos sobre la restauración de staging. Confirmar autenticación real y ACL administradas, comparar datos y saldos originales, y ejecutar con dos conexiones: última unidad, duplicación de clave, abonos concurrentes, devolución/abono, doble devolución, cierre/venta y edición/venta. SQL Editor no sirve para validar RPC de usuario fabricando claims: require_staff rechaza deliberadamente contextos que no proceden del gateway.

Si staging y respaldo pasan, obtener autorización del lote exacto y mantener la ventana sin escritores ni migradores paralelos. Utilizar conexión directa o pooler de sesión, no pooler de transacciones. Configurar PGHOST/PGPORT/PGDATABASE/PGUSER/PGSSLMODE mediante los datos de Connect y solicitar la contraseña interactivamente. No alterar el usuario de ejecución entre archivos.

Ejemplo preparado para **006 solamente**; no se ejecutó:

```powershell
psql -X -W -v ON_ERROR_STOP=1 --command="SET lock_timeout='5s'; SET statement_timeout='120s';" --file=supabase/migrations/20261023000600_catalog.sql
if ($LASTEXITCODE -ne 0) { throw 'DETENER: 006 no confirmada; no continuar ni registrar historial' }
```

Los tiempos son límites iniciales para ensayar, no garantías de duración. Si el volumen los supera, investigar bloqueos y medir en staging antes de ajustarlos. No agregar --single-transaction ni otro BEGIN alrededor de los archivos: ya contienen su propia transacción. No ejecutar selecciones sueltas del editor ni continuar desde la línea que falló.

Tras el COMMIT confirmado, validar 006 antes de cualquier 007: objetos/columnas/constraints/índices, RLS/ACL/propietarios, ningún CREATE residual, datos/saldos originales intactos y definición de la RPC. Si se usó psql/SQL Editor, registrar **solo 20261023000600**, mediante el mecanismo de historial CLI ya adoptado y después de auditar. migration repair --status applied solo registra historial, no aplica ni valida SQL. Verificar proyecto vinculado y registro único. Si falla el registro, detenerse y reconciliar; no volver a ejecutar el archivo ya confirmado.

Repetir explícitamente el mismo proceso con 007 y después 008, sin bucle automático. No ejecutar db push sin comprobar exactamente qué archivos ejecutaría; no reset, repair masivo, recreación de tablas ni edición de las versiones aplicadas 001–005.

## Validación posterior y criterios de parada

Validar después de cada versión y al final:

- Historial único y ordenado de las versiones realmente confirmadas; hashes exactos del lote.
- Objetos, columnas/tipos/defaults, FK/CHECK/UNIQUE, índices válidos, triggers habilitados y vista coherente con el archivo.
- Tablas/vistas financieras siguen con pos_owner; puente privado de 005 sigue con el propietario confiable; RPC nuevas pos_owner/SECURITY DEFINER/search_path fijo; capture_sale_cost invoker. RLS y ACL efectivas correctas; authenticated solo recibe EXECUTE específico de RPC, sin lecturas/escrituras directas; pos no expuesto.
- CREATE de pos_owner sigue false en pos/public. Revisar warnings de GRANT y ausencia de privilegios heredados no previstos.
- Filas e importes financieros originales, existencias y cartera coinciden con la línea base congelada; con sale_returns vacía, la sustitución de vista no debe alterar saldos previos. Ningún backfill de costo histórico.
- PostgREST reconoce las tres firmas después del NOTIFY al COMMIT. Con JWT reales de staging: sin sesión/inactivo denegado; cajero sin permisos no modifica productos, cupos, perfiles ni devoluciones; admin/supervisor según contrato. Los reportes no muestran datos globales restringidos al cajero. Probar la API sin registrar JWT ni respuestas sensibles.

Detenerse ante cualquier objeto previo inesperado, definición divergente, permiso insuficiente, warning de GRANT, error SQL/timeout/deadlock/desconexión, fallo en COMMIT, cambio de saldos/filas, ACL/owner/RLS incorrectos, registro duplicado/fallido o fallo del ensayo de restauración/concurrencia. No conceder superusuario, acceso amplio o exposición de pos para continuar.

Si falla un archivo antes del COMMIT, su transacción debe revertirse; cerrar/revertir la sesión abortada y comprobar estado desde una conexión nueva. Si la conexión cae alrededor del COMMIT, el resultado es ambiguo: inspeccionar objetos e historial antes de reintentar. Si 006 quedó confirmada y 007 falla, 006 no se revierte automáticamente. Mantener el sistema en mantenimiento y revisar el estado exacto. Después de COMMIT no existe un ROLLBACK retrospectivo: usar corrección revisada o recuperación ensayada/autorizada, considerando operaciones posteriores; nunca borrar ventas o marcar versiones reverted para simular recuperación.

## Evidencia local de esta revisión

- Lectura completa de 006, 007 y 008 y análisis de sus dependencias 001/002/004/005, invariantes y consumidores.
- 19/19 pruebas de catálogo, operaciones y reportes correctas.
- Nueva prueba tests/credit/migration-upgrade.spec.ts correcta: crea venta 200, pago inicial 50 y abono 30 antes de 006–008; compara las proyecciones originales de todas las tablas/vistas pos después de aplicar; conserva saldo 120 y CREATE revocado. TypeScript de pruebas correcto.
- El primer ensayo temporal falló por un cast omitido en el Auth simulado, no en las migraciones. El ensayo definitivo reutiliza el fixture existente correcto y pasó.
- PGlite no certifica privilegios del Supabase alojado, firmas JWT, restauración real ni concurrencia de sesiones PostgreSQL independientes. Ningún SQL remoto, respaldo remoto, migración de producción, commit o despliegue fue ejecutado.

No se requiere una corrección demostrada de los archivos para continuar el ensayo de staging. Para habilitar producción deben cerrarse las condiciones anteriores con evidencias; el registro de 001–005 y la ausencia de seis tablas no sustituyen esas comprobaciones.
