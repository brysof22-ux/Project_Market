# Aplicación de 006–008 en Supabase original

**Resultado: PASS. Base de datos operativa a nivel PostgreSQL, barrera desactivada y permisos originales restaurados.** Proyecto exclusivo: `sauoekefntzxhqxycdgo`. Finalización: **25/10/2026 19:11:59 Colombia** (`2026-10-26T00:11:59.223Z`). Confirmación independiente de solo lectura: **19:14:04 Colombia**.

La autorización del usuario comprendió la renovación temporal, la barrera de ACL ensayada y estas tres migraciones. No se desplegaron Workers/Pages, no se hicieron commits ni fusiones y no se ejecutaron operaciones comerciales de prueba en producción. No reejecutar estas migraciones ni usar las guías históricas como instrucciones pendientes.

## Condiciones previas comprobadas

- Renovación oficial de `cli_login_postgres`, credencial manejada en memoria y archivo privado protegido mediante Windows DPAPI; sin contraseñas en argumentos, informes o repositorio.
- Tres conexiones PostgreSQL autenticadas independientes: control, migración y recuperación. TLS con verificación completa de cadena y nombre del servidor (`verify-full`, `rejectUnauthorized=true`), CA oficial fijada por huella. Usuario efectivo `postgres`, usuario de sesión `cli_login_postgres`, sin superusuario.
- Respaldo original `E:\CAI_Market_Backups\20261025T190552Z_sauoekefntzxhqxycdgo_dffc5be4`, capturado a las 14:06 Colombia, y paquete recuperable verificado `E:\CAI_Market_Backups\20261025T202847Z_sauoekefntzxhqxycdgo_verified_bundle`. Los diez archivos originales conservaron sus SHA-256. La comparación fresca de datos y metadatos confirmó su vigencia antes del lote; no se detectaron cambios comerciales posteriores. El suplemento de ACL administradas de GraphQL del paquete se utilizó exclusivamente en la recuperación local, nunca en producción.
- Historial inicial exactamente 001–005; sin registros ni objetos parciales de 006–008. Estructura, funciones, roles y permisos compatibles con lo ensayado.
- Ensayo adicional del ejecutor exacto sobre `cai_production_acl_finalproof`, copia independiente de la recuperación aislada: PASS, sin insertar datos comerciales. Huella del ejecutor: `5d7bb6a9295dbb18ff732073c23dfed878c8678b6ce3c3a3dcfb8da5c90b697a`.

## Mantenimiento y ejecución

Se capturaron las ACL completas originales de las 23 tablas preexistentes y el inventario de escritores. Se retiraron únicamente INSERT, UPDATE, DELETE y TRUNCATE de `pos_owner` en esas tablas y SELECT sobre la compuerta de idempotencia. La matriz de privilegios efectivos confirmó el cierre, sin operaciones comerciales de prueba. El inventario verificó funciones escritoras y ausencia de caminos alternativos de escritura para los roles de aplicación; la exclusión no dependió de un advisory lock ni de cooperación del frontend/Worker.

El cierre se hizo en una transacción breve con bloqueos exclusivos NOWAIT para descartar escritores en curso. Las capturas posteriores terminaron sus transacciones antes de DDL. Se comprobaron `pg_stat_activity`, `pg_locks` y transacciones preparadas antes de cada migración, con límites de espera y parada ante bloqueos inesperados. No se conservaron bloqueos de lectura entre archivos.

| Migración | Aplicación | Validación antes de continuar | Historial |
| --- | --- | --- | --- |
| `20261023000600_catalog.sql` | Confirmada | Estructura, datos originales y permisos: PASS | `20261023000600`, catalog, 23 sentencias |
| `20261023000700_operations.sql` | Confirmada | Vista de saldos, abonos, integridad y objetos: PASS | `20261023000700`, operations, 29 sentencias |
| `20261023000800_reports.sql` | Confirmada | Definición y permisos de reportes, modelo de lectura: PASS | `20261023000800`, reports, 12 sentencias |

Cada archivo original se ejecutó en su transacción, se validó y se registró antes de continuar. Las filas de historial utilizaron exactamente el nombre y las sentencias producidos por el procedimiento del CLI oficial en el ensayo; sus huellas coinciden. No se ejecutaron reparaciones, restauraciones ni cambios de esquema adicionales.

SHA-256 de los archivos aplicados, idénticos a los ensayados:

```text
006 9009E00E84822B795FEC8D6C9A5AC60F6C40042D61287B2271343FC2606E4237
007 D11B144C9C009EA6AE528E76A9AEC5B6828DECBC2119A83B34CB6A8C92704B8F
008 FA463CCF22DB5ED6E66A5290053A24F854181E27BF362A751F26D7104B36F08B
```

## Auditoría y comparación final

- Las huellas de las **63 tablas y 262 filas originales** se conservaron, comparando las columnas originales y, en el historial, las versiones originales. Se añadieron únicamente los objetos previstos y las tres filas nuevas del historial. Secuencias originales sin diferencias.
- Tablas: 63 → 69; tablas `pos`: 23 → 29. Funciones: 129 → 133. Estado final inventariado: 326 restricciones, 219 índices y 37 triggers no internos. Coincidencia con el ensayo del ejecutor exacto, incluyendo restricciones validadas, índices válidos y triggers habilitados.
- `v1_postmigration_integrity.sql`: PASS con la barrera activa y tras restaurar permisos. Comprobaciones de totales, existencias no negativas, saldos, asignaciones de abonos, movimientos de caja, duplicados, devoluciones y cierres sin inconsistencias.
- En el origen no había ventas, pagos, movimientos de inventario, cargos de crédito, abonos ni entradas de caja; continúan vacíos. Las seis tablas nuevas están vacías. Estos controles sobre producción no sustituyen los escenarios con datos y concurrencia ejecutados previamente en copias aisladas.
- El modelo SQL de lectura del reporte para 19–25 de octubre devolvió ventas netas, cobros y cartera en cero, como corresponde al origen. Se ejecutó como lectura administrativa, sin llamar a la RPC con un JWT fabricado ni suplantar usuarios.
- Todas las tablas `pos` mantienen propietario `pos_owner` y RLS. No se cambiaron propietarios financieros. Las RPC nuevas son SECURITY DEFINER con `search_path=pg_catalog, pos, pg_temp`; EXECUTE para `authenticated`, sin ejecución para `anon`, `service_role`, `pos_app` ni `pos_scheduler`. Se verificaron también la función de trigger y el resto de definers. No se añadieron permisos amplios ni se expuso `pos` en la Data API.
- Permisos originales de las 23 tablas restablecidos, con comparación literal de las ACL explícitas y comparación semántica. SELECT de idempotencia restablecido. Las seis tablas nuevas conservan los permisos previstos por las migraciones. Las nuevas concesiones de las RPC son cambios esperados, no parte de la barrera temporal.
- `pos_owner` continúa sin CREATE en `pos` y `public`, sin LOGIN ni privilegios elevados. No se modificaron permisos de `auth`. Auditoría final: sin bloqueos sobre relaciones `pos` ni transacciones preparadas; clientes restantes inactivos y sin transacción abierta.
- La segunda comprobación mediante el endpoint oficial de solo lectura confirmó `transaction_read_only=on`, historial 001–008, 29 tablas `pos`, cero tablas con propietario/RLS inseguros, permisos de escritura del propietario restaurados, compuerta SELECT abierta y ausencia de acceso directo de escritura para los roles de aplicación.

## Evidencias y límites

Evidencias privadas fuera del repositorio: `E:\CAI_Market_ProductionRuns\20261025T234810Z_acl`. Incluyen resultados, conexiones TLS autenticadas, capturas anteriores/intermedias/finales, matrices de privilegios, actividad, historial y SQL de restauración exacta de ACL. No publicar su contenido íntegro: las capturas pueden contener metadatos o información del origen y existe un archivo de sesión cifrado localmente.

El respaldo conservado es el **punto de recuperación anterior a la actualización**. No se restauró sobre producción. La renovación temporal tiene caducidad oficial; no se amplió su alcance. El respaldo PostgreSQL no sustituye respaldos de objetos Storage, configuración externa de Auth, secretos ni configuración de Cloudflare.

No hubo errores relevantes en la ejecución autorizada. La base quedó operativa para el esquema V1 y con los permisos originales de mantenimiento restaurados. **Esto no certifica todavía la aplicación publicada:** quedan pendientes la verificación de autenticación HTTP, el Worker compatible y Cloudflare Pages, sujetos a autorización independiente. Los SQL 006–008 ya aplicados no deben modificarse; cualquier corrección posterior requiere una migración nueva.
