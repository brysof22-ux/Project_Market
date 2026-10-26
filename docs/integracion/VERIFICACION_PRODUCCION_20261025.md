# Verificación de producción previa a 006–008

**Documento histórico.** Tras la autorización explícita, las migraciones se aplicaron con PostgreSQL autenticado y TLS verify-full el 25/10/2026. Ver [resultado definitivo](RESULTADO_PRODUCCION_006_008_20261025.md); no reejecutar el lote usando este estado previo.

Proyecto exclusivo: `sauoekefntzxhqxycdgo`. Última captura de solo lectura: **25/10/2026, 15:30:01 Colombia** (`20:30:01Z`). Resultado favorable para preparar una aplicación controlada; **ninguna migración ejecutada**.

## Acceso y alcance real de TLS

No se renovó ni creó un rol para esta verificación. La credencial temporal anterior había caducado y se respetó la instrucción de no modificar producción.

Las consultas se ejecutaron por HTTPS en el [endpoint oficial de solo lectura](https://supabase.com/docs/reference/api/v1-read-only-query), con `current_user=session_user=supabase_read_only_user`, `transaction_read_only=on` y BYPASSRLS administrado ya existente. No se usó el endpoint SQL de escritura ni se cambió ningún permiso. Se comprobó este contexto para no confundir tablas vacías por RLS con ausencia real de registros. La credencial del CLI se leyó de Windows Credential Manager exclusivamente en memoria; no se imprimió ni guardó en archivos.

Por separado se envió un PostgreSQL SSLRequest al pooler de sesión original. La negociación TLS 1.3 pasó con la CA oficial fijada por SHA-256 `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`, validación de cadena y nombre de servidor, sin aceptar certificados inválidos. Es la comprobación de transporte que exige `verify-full`.

**Límite:** esa sonda TLS no autenticó una sesión PostgreSQL. No se presenta como un `psql` autenticado con `sslmode=verify-full`; la lectura SQL autenticada fue por la API HTTPS de solo lectura. Antes de cualquier DDL se debe renovar el acceso temporal autorizado y abrir/comprobar la sesión PostgreSQL autenticada con `verify-full`. Si falla, no se ejecuta el lote. No se relajará TLS para continuar.

## Estado observado

- Historial exactamente 001–005; se conservan las filas completas de las cinco versiones.
- Ningún registro 006–008; ninguna de sus RPC, función de captura de costos, seis tablas, nueve índices explícitos, trece columnas o trigger de snapshot existe parcialmente.
- 63 tablas y 262 filas originales: conteos y huellas de todos los campos coinciden con la captura del respaldo. No se detectaron registros comerciales nuevos ni cambios persistentes en Auth u otras tablas inventariadas.
- Coinciden los 129 cuerpos/propietarios/configuraciones de funciones, 275 restricciones, 199 índices, 32 triggers no internos, siete secuencias, roles y membresías. Las tres vistas financieras conservan exactamente sus definiciones del respaldo, incluida `pos.credit_charge_balances`.
- Cartera, abonos, ventas, pagos, caja e inventario coinciden con el respaldo: no hay operaciones comerciales ni existencias registradas. Se conservan el perfil y los métodos de pago originales.
- Cero stock negativo, crédito negativo, ventas inconsistentes, abonos sin distribuir y entradas de efectivo duplicadas.
- `pos_owner` conserva USAGE, carece de CREATE en `pos`/`public` y mantiene sus atributos de seguridad. `postgres` conserva capacidad de conceder CREATE y SET ROLE pos_owner. Los permisos de funciones y el puente de 005 son compatibles con el lote ensayado.
- Los SHA-256 de 006–008 coinciden exactamente con los del ensayo aprobado. No se modificaron los SQL.

La cuenta de auditoría no tiene EXECUTE sobre `business_now()`. No se concedió ese permiso: la consulta de saldos se formuló con los libros base y la misma expresión de principal menos abonos de 001–005. La definición de las vistas se comparó independientemente. La primera consulta que intentaba usar la vista protegida se rechazó sin cambios.

## Diferencia detectada y recuperación completada

Comparar la producción real con la restauración reveló que los esquemas administrados `graphql` y `graphql_public` tenían en origen privilegios iniciales que no aparecían como GRANT independientes en el dump. En ambos, el catálogo de producción confirmó `nspacl=initprivs` y `privtype='e'`. No se observó una modificación posterior de datos; son privilegios iniciales administrados. [PostgreSQL explica su representación en pg_init_privs](https://www.postgresql.org/docs/17/catalog-pg-init-privs.html).

La validación anterior del esquema había comprobado el SQL que exportó el dump; esa igualdad no demostraba por sí sola la reproducción de estos privilegios iniciales omitidos. Se amplió la recuperación sin reescribir archivos originales:

1. Nueva copia del volumen restaurado, conservando el original detenido y montado de solo lectura para copiarlo.
2. Suplemento separado `managed-initial-acls.local.sql`, **solo para recuperación local**, que reproduce USAGE de esos dos esquemas para los roles ya autorizados en origen y la opción de concesión de `postgres`. No modifica `pos`, `public` ni `auth`, no concede CREATE y no es una migración de producción.
3. Aplicación del suplemento únicamente en la nueva copia aislada, sin red ni puertos.
4. Comparación completa con el estado real: tablas/datos, vistas, roles, membresías, ACL de esquemas/tablas/funciones, privilegios predeterminados, funciones, índices, restricciones, triggers, secuencias y finanzas: **todo coincide**.

Las diferencias de orden de entradas ACL y la representación `NULL` frente al ACL explícito de propietario único se normalizaron por sus privilegios efectivos, conservando roles, otorgantes y opciones de concesión. No se ignoró ninguna diferencia sustantiva de permisos.

Paquete de recuperación complementado y verificado:

```text
E:\CAI_Market_Backups\20261025T202847Z_sauoekefntzxhqxycdgo_verified_bundle
```

Incluye los diez archivos originales con sus mismos SHA-256, las adaptaciones locales ya verificadas de roles/extensiones, el suplemento de privilegios iniciales, el catálogo actual y las evidencias de comparación. Su manifiesto registra la procedencia y los hashes. **No es un pg_dump nuevo:** los datos se exportaron a las 14:06:24 y se comprobaron idénticos a las 15:30:01. Se conservó ese contenido y se completó la recuperación de metadata administrada. No hubo cambios de datos que obligaran a regenerar el archivo de datos. Los componentes externos de Supabase y contraseñas de conexión de roles siguen fuera de esa recuperación lógica.

El respaldo tiene aproximadamente **84 minutos** a la hora de la última verificación y cubre íntegramente el estado observado, con el suplemento. Su vigencia no se basa solamente en la edad: se apoya en la igualdad de contenido y metadatos. Ninguna verificación garantiza cubrir escrituras futuras; volver a comprobar al inicio de la ventana y detenerse si hay diferencias.

## Procedimiento exacto preparado, no ejecutado

Ejecutor privado revisable:

```text
E:\CAI_Market_Preflight\20261025T201404Z\Invoke-CaiProductionSql.prepared.ps1
```

No ejecuta nada sin `-Authorized`, una conexión al proyecto exacto, contraseña temporal en memoria, `PGSSLMODE=verify-full`, CA fijada y coincidencia de los tres hashes ensayados. El indicador no sustituye la autorización humana. Usa cliente PostgreSQL 17.11 fijado por digest y `SET ROLE postgres` explícito; no depende de opciones de inicio que el pooler pueda ignorar. Los logs se conservan privadamente. Su sintaxis PowerShell se verificó; no se ha probado mediante DDL remoto.

Después de autorización humana, realizaré esta secuencia, no un bucle que continúe ante errores:

1. Acordar ventana sin escritores comerciales ni otro migrador. Revalidar hashes, estado original y vigencia del paquete de recuperación. Si hubo escrituras relevantes, generar y restaurar una nueva captura antes de continuar.
2. Renovar exclusivamente `cli_login_postgres` con el mecanismo oficial, sin cambios de permisos de aplicación ni desbloqueos de red. Mantener la contraseña en memoria. Abrir conexión PostgreSQL autenticada con CA y `sslmode=verify-full`, host del pooler original, puerto 5432, base postgres, usuario `cli_login_postgres.sauoekefntzxhqxycdgo`; verificar rol efectivo postgres, atributos y proyecto. Una autenticación fallida detiene el proceso.
3. Ejecutar `preflight` y `baseline` mediante el ejecutor. El primero debe acreditar 001–005 y ausencia completa de restos; guardar la línea base financiera y las proyecciones originales completas, no solo totales.
4. Ejecutar acción `006`: archivo completo `20261023000600_catalog.sql`, con `lock_timeout=5s`, `statement_timeout=120s`, `ON_ERROR_STOP=1`, sin otro BEGIN externo. Confirmar COMMIT y comprobar objetos, defaults, índices, ACL/RLS/propietarios, función y CREATE revocado; comparar las filas, vistas, saldos y secuencias originales. Solo entonces ejecutar `register006` y comprobar fila única, nombre y statements.
5. Ejecutar `007`, validar lo anterior y especialmente definición/columnas/ACL de `credit_charge_balances`, saldos y abonos anteriores, ausencia de devoluciones/backfill creados por el DDL y trigger de costos correcto. Solo entonces `register007`.
6. Ejecutar `008`, validar RPC SECURITY DEFINER/search_path/EXECUTE y conservación de datos. No fabricar claims ni transacciones comerciales para probar reportes en producción; guardar la comprobación SQL de su definición y hacer integración HTTP con sesión real en la etapa autorizada correspondiente. Solo entonces `register008`.
7. Ejecutar `audit` (`v1_postmigration_integrity.sql`), repetir línea base y comparación de registros, objetos, ACL/RLS/propietarios, secuencias y finanzas. Historial exactamente 001–008, sin CREATE residual ni exposición de `pos`. La exposición Data API sigue siendo configuración externa que debe conservarse; no se cambia aquí.

Ejemplo de invocación preparado para una sola acción, que **no he ejecutado**:

```powershell
& 'E:\CAI_Market_Preflight\20261025T201404Z\Invoke-CaiProductionSql.prepared.ps1' -Action '006' -Authorized
```

El registro individual usa `register_20261023000N00.prepared.sql`, que escribe únicamente `version`, `name` y `statements` en `supabase_migrations.schema_migrations`, después de la validación. Se extrajeron del CLI oficial usado en el ensayo: 23, 29 y 12 statements. Se ensayaron los tres scripts de registro en otra base aislada y sus ocho filas finales coinciden exactamente con las producidas por el CLI. Esto conserva el resultado del procedimiento del proyecto mediante la misma conexión de migrador, evitando que un segundo cliente de registro renueve roles o haga reintentos de red por su cuenta. No vuelve a ejecutar las sentencias almacenadas como texto.

**Parada obligatoria:** cualquier error SQL, warning de permisos, timeout, desconexión, COMMIT ambiguo, diferencia inesperada de filas/saldos/ACL o fallo de registro. No reintentar automáticamente, no continuar con el siguiente archivo, no marcar aplicada una versión sin validar y no eliminar datos. Una versión ya confirmada no se deshace con ROLLBACK; cualquier reparación o restauración sobre producción requiere revisión/autorización.

## Riesgos pendientes y autorización

Falta renovar/autenticar el acceso PostgreSQL de ejecución; no se hizo para respetar el alcance actual de solo lectura. También se necesita controlar la ventana de escritores para que no cambie el estado después de la captura. Los ALTER TABLE/CREATE INDEX pueden tomar bloqueos; se usarán los límites ensayados. El paquete es PostgreSQL lógico, no un respaldo de todos los servicios externos.

Estas comprobaciones no despliegan ni certifican Auth HTTP, Worker o Pages. No se ejecutó DDL/DML ni cambios de roles en producción, no hubo commits o fusiones en main y los contenedores locales de comprobación quedaron detenidos. Antes de ejecutar el lote se solicita autorización explícita que incluya renovación del acceso temporal, 006→007→008, validación y registro individual de historial, exclusivamente en el proyecto original. No incluye despliegues ni operaciones comerciales de prueba.
