# Respaldo y ensayo de actualización V1.1 — 26 de octubre de 2026

Proyecto original exclusivo: `sauoekefntzxhqxycdgo`.

**Resultado final: respaldo PostgreSQL restaurado y verificado; ensayo de 009
corregida, mantenimiento, historial oficial y escenarios ficticios aprobados.**
No se aplicó 009 ni se ejecutaron operaciones comerciales sobre producción.

## Respaldo y restauración comprobados

Respaldo privado reciente:

```text
E:\CAI_Market_Backups\20261026T120305Z_sauoekefntzxhqxycdgo_v11_a7bc3671
```

Captura consistente de datos/catálogos: `2026-10-26T12:04:15.418Z`
(07:04:15 Colombia). El manifiesto de exportación se completó a las 07:05:15.
Los diez archivos originales coinciden con sus SHA-256. No se reescribieron.

La restauración se inicializó desde cero en Supabase PostgreSQL `17.11.0.003`
(PostgreSQL 17.11), imagen fijada por digest:

```text
public.ecr.aws/supabase/postgres@sha256:7374d196da7e301512cc5329e18040e0f7bb856287b323777cdadecccbc6c7e4
```

Contenedor de recuperación: `cai-v11-restore-4152fcdd`. Volumen:
`cai-v11-restore-4152fcdd-data`. Se encuentra detenido y se conserva como punto
de recuperación. Se utilizó `--network none`, ningún puerto publicado y únicamente
socket Unix `/tmp`; no se iniciaron Auth, PostgREST, Storage ni emisores de mensajes.
El archivo de sesión DPAPI no se montó en los contenedores.

Trabajo privado y registros:

```text
E:\CAI_Market_Rehearsals\20261026T120616Z_v11_4152fcdd
```

La carpeta tiene ACL para el usuario Windows actual y SYSTEM. Contiene SQL con
datos Auth del respaldo y no debe publicarse ni incorporarse a Git. Los resultados
incluidos en este informe sólo contienen conteos y metadatos técnicos.

| Comparación con la captura original | Resultado |
| --- | --- |
| 69 tablas y 269 filas, todas las columnas originales | Conteos y huellas coinciden |
| Roles y membresías, otorgantes y opciones de concesión | Coinciden |
| ACL efectivas de esquemas, relaciones y funciones | Coinciden |
| Políticas RLS y privilegios predeterminados | Coinciden |
| Funciones, propietarios, SECURITY DEFINER y configuración | Coinciden |
| Restricciones, índices y triggers | Coinciden |
| Siete secuencias, valores e `is_called` | Coinciden |
| Historial 001–008, stock y libros financieros | Coinciden |
| Archivos originales después del ensayo de restauración | Sin modificaciones |

Las copias de trabajo documentan estas adaptaciones exclusivamente locales:

1. Se comentó únicamente `CREATE ROLE supabase_admin;`, porque `initdb` lo creó
   previamente como usuario inicial OID 10. Se conservaron su ALTER ROLE y todas
   las concesiones de roles del respaldo.
2. `pg_stat_statements`, `pgcrypto` y `uuid-ossp` se crearon bajo la identidad
   original `postgres`, con SUPERUSER sólo durante esa restauración sin red. Un
   bloque `finally` lo devolvió a NOSUPERUSER, verificado al comparar los roles.
3. El catálogo de origen confirmó que ocho concesiones USAGE de los esquemas
   `graphql` y `graphql_public` eran privilegios iniciales administrados omitidos
   como GRANT independientes por el dump. Se agregaron exactamente esas ocho
   concesiones que faltaban en la copia local, conservando otorgante y opción de
   concesión. No se retiraron permisos ni se alteraron `pos`, `public` o `auth`.

## Primer ensayo 009: detención correctamente activada

Se copió el volumen de recuperación detenido y montado de sólo lectura a un
volumen independiente: `cai-v11-upgrade-4152fcdd-data`. El clon anterior al SQL
coincidió nuevamente con todos los hashes y grupos de catálogo del respaldo.
El preflight de 001–008 y ausencia de restos de 009 pasó.

La aplicación local de 009 emitió dos advertencias:

```text
WARNING: no privileges could be revoked for "current_profile_auth_uid"
```

La función puente de 005 pertenece a la identidad administrativa que la creó.
El propietario operativo `pos_owner` no tiene capacidad para revocar sus
privilegios. La revocación masiva de funciones de `pos` en dos lugares de 009
incluía ese puente, aunque debía conservarlo con sus ACL originales.

El arnés se detuvo inmediatamente y no registró 009 ni ejecutó operaciones
ficticias. La transacción SQL del clon pudo confirmar sus cambios antes de que
el cliente examinara las advertencias; ese clon se conserva detenido como intento
fallido y no se utiliza como punto de recuperación. No hubo errores SQL ni cambios
en Supabase original, pero este intento no se considera aprobado para producción.

La corrección local excluye expresamente el puente de las revocaciones y conserva
sus propietarios y ACL. Añade una comprobación previa que rechaza ACL inesperadas
del puente. Se ensayó desde otra copia del volumen de recuperación verificado;
no se reparó destructivamente el clon anterior.

## Ensayo corregido aprobado

Archivo revisado, aplicado exclusivamente en el clon:

```text
supabase/migrations/20261025000900_v11_periods_permissions.sql
SHA-256 6e7c588f6cd9bdd91f85b33cb9a90610e27d49aecfc2c544f92280b9f336d810
```

Trabajo final privado:

```text
E:\CAI_Market_Rehearsals\20261026T122636Z_v11_a1ed07bf
```

Contenedor del ensayo: `cai-v11-upgrade-a1ed07bf`, volumen independiente
`cai-v11-upgrade-a1ed07bf-data`. Tanto este contenedor como el de recuperación
quedaron detenidos. El volumen de recuperación se montó de sólo lectura al copiar;
la migración y los escenarios ficticios se ejecutaron exclusivamente en el clon.

1. La copia previa a 009 volvió a coincidir con los 69 hashes de tablas y los
   17 grupos de catálogo del respaldo. El preflight de 001–008 pasó.
2. Se capturaron las ACL originales de las 29 tablas `pos`. El dump había
   representado los privilegios completos exclusivos del propietario como ACL
   `NULL` por defecto; sólo en el clon se materializó esa misma concesión efectiva
   al mismo propietario, comprobando igualdad literal con el catálogo de origen.
   No se añadieron roles, privilegios efectivos u opciones de concesión.
3. En una transacción breve se tomaron bloqueos exclusivos NOWAIT, se retiraron
   INSERT/UPDATE/DELETE/TRUNCATE de `pos_owner` en las 29 tablas y SELECT sobre
   `idempotency_requests`, y se confirmó la transacción antes de iniciar DDL.
   No quedaron bloqueos de lectura persistentes. `pg_stat_activity` y `pg_locks`
   se comprobaron antes y después del corte y alrededor de 009.
4. Un intento ficticio de escritura, con identidad local creada dentro de una
   transacción que se revirtió, fue rechazado antes y después de 009. La barrera
   puede rechazarlo en `require_staff`: su SELECT FOR SHARE sobre `profiles`
   requiere UPDATE y queda impedido por el corte. También queda cerrado el
   acceso a la compuerta de idempotencia. No se confía en un advisory lock.
5. 009 terminó sin advertencias ni errores; los 269 registros originales y sus
   columnas anteriores se conservaron. No se alteraron los archivos 001–008.
6. El CLI oficial Supabase 2.122.0 ejecutó `migration repair --status applied`
   con conexión explícita al socket Unix del clon, sin `--linked` ni credenciales
   de servicios remotos. Se verificaron nueve versiones en el historial y las
   **58 sentencias** de la fila 009. El nombre es `v11_periods_permissions`.
7. La auditoría posterior de integridad y seguridad pasó antes de insertar datos
   ficticios. Las ACL de las 29 tablas se restauraron y compararon literalmente
   con la captura original. Los permisos CREATE temporales quedaron retirados.
8. Se ejecutaron cuatro grupos de escenarios ficticios, descritos abajo, y se
   repitió la auditoría sobre todos los períodos después del reinicio.

El arnés también ejerció su recuperación de ACL durante una detención de prueba:
`finally` devolvió las 29 ACL a sus valores originales y lo comprobó antes de
detener el contenedor. Los intentos anteriores y sus diagnósticos se conservaron.

### Resultados de los escenarios ficticios en la copia restaurada

| Grupo | Resultado |
| --- | --- |
| Venta al contado y crédito por cajero sin cupo previo | Aprobado: precios calculados por servidor y existencias descontadas |
| Abono inicial de 25 en venta de 100 | Principal de crédito 75; ningún recibo duplicado por el pago inicial |
| Abono posterior dirigido de 30 y reintento con misma clave | Un recibo; saldo 45; sobrepago rechazado |
| Solicitudes SQL directas administrativas por cajero | Catálogo, gastos, usuarios, límites, devoluciones y reinicio rechazados |
| Caja de otro empleado y perfil Supervisor | Caja ajena rechazada con FORBIDDEN; Supervisor conservado y bloqueado |
| Devolución administrativa del crédito con pagos recibidos | Reintegro 55, reducción de deuda 45, saldo cero y stock repuesto una sola vez |
| Reinicio con cajas abiertas o sin autenticación reciente | Rechazado sin cambiar de período |
| Reinicio autorizado con cajas cerradas | Nuevo período, stock activo cero, productos/precios/perfiles conservados |
| Archivo posterior al reinicio | Tres ventas conservadas, ocho unidades históricas y una deuda de 100 conservadas en el período anterior |
| Reintento del mismo reinicio | Mismo resultado; no crea otro período |
| Abono dirigido a una deuda archivada desde el período nuevo | Rechazado; no mezcla saldos entre períodos |
| Auditoría final de todos los períodos | Aprobada, sin inconsistencias de ventas, pagos, abonos, caja, restricciones o referencias cruzadas |

Las identidades usadas en estas pruebas sólo se insertaron en PostgreSQL aislado;
no tienen contraseñas reales ni sesiones verificadas por el servidor Auth. El
usuario/perfil administrativo original conservó su información durante el upgrade.

Los archivos privados de registro reproducible para una futura aplicación
autorizada se generaron desde la fila real producida por el CLI:

```text
official-cli-history-009.json
register_20261025000900.prepared.sql
```

No se ejecutó ese script de registro sobre producción. La fila contiene el SQL
como texto de historial; registrarla no vuelve a ejecutar sus 58 sentencias.

### Reproducción del ensayo

El controlador `scripts/v11/restore-rehearse.mjs` exige rutas privadas de respaldo
y trabajo nuevo; verifica proyecto, manifiesto, hash SQL y aislamiento de Docker.
No acepta una URL PostgreSQL remota. El tercer argumento opcional es la carpeta de
evidencia de una restauración ya verificada, cuyo contenedor debe estar detenido.
La carpeta nueva de trabajo debe crearse previamente con ACL privada.

```powershell
node scripts/v11/restore-rehearse.mjs `
  'E:\CAI_Market_Backups\20261026T120305Z_sauoekefntzxhqxycdgo_v11_a7bc3671' `
  '<NUEVA_CARPETA_PRIVADA_VACIA_EN_E:\CAI_Market_Rehearsals>' `
  'E:\CAI_Market_Rehearsals\20261026T120616Z_v11_4152fcdd'
```

Este comando crea otro contenedor/volumen. No debe apuntar la carpeta de trabajo
a un respaldo, una carpeta existente con archivos o un directorio de producción.

## Alcance de recuperación

Este resultado acredita recuperación lógica PostgreSQL del estado capturado.
No incluye objetos R2/Storage, secretos de Cloudflare, configuración externa Auth,
claves de cifrado externas ni contraseñas globales de roles. No se restauró nada
sobre producción. Las comprobaciones con claims de `authenticator` dentro de una
copia aislada no equivalen a verificar una sesión JWT real contra Supabase Auth.

El ensayo corregido, el registro de historial oficial y la auditoría posterior
están aprobados localmente. La publicación sigue condicionada a revalidar la
vigencia del respaldo y el estado del origen al abrir la ventana, las verificaciones
de entorno pendientes y la autorización humana explícita para modificar producción.
